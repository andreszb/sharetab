# NixOS service for ShareTab.
#
# This replaces docker/entrypoint.sh. The container image bundles its own
# PostgreSQL and runs initdb on first boot; on NixOS the system cluster is a
# better fit, so the database is declared with ensureDatabases/ensureUsers and
# reached over the unix socket with peer authentication.
#
# The reverse proxy is deliberately not configured here — the module exposes a
# loopback port and leaves TLS and vhost routing to the host.
{ config
, lib
, pkgs
, ...
}:
let
  cfg = config.services.sharetab;

  inherit (lib) mkIf mkOption mkEnableOption types getExe;

  app = "${cfg.package}/share/sharetab";

  # Unix socket connection. The user goes in the authority rather than in a
  # `user=` parameter: libpq honours the parameter form
  # (postgresql:///db?host=/run/postgresql&user=x), and psql connects with it
  # fine, but Prisma's Rust schema engine ignores it and fails the whole
  # pre-start with "P1010: User was denied access on the database". The
  # authority form is what Prisma documents for sockets, and node-postgres —
  # which the app itself uses via @prisma/adapter-pg — accepts it too.
  #
  # `localhost` in the authority is not where it connects; `?host=` selects
  # the socket directory. It is a placeholder the URL grammar requires.
  #
  # Peer auth is why the unit runs as a static user rather than under
  # DynamicUser: PostgreSQL matches the OS user name against the role.
  localDatabaseUrl = "postgresql://${cfg.user}@localhost/${cfg.database.name}?host=/run/postgresql";

  # Replaces docker/claude. The Claude Agent SDK shells out to an executable
  # literally named `claude`, so it has to be resolvable on PATH; it also
  # insists on a writable HOME, which is stateDir.
  claudeShim = pkgs.writeShellApplication {
    name = "claude";
    runtimeInputs = [ cfg.package.passthru.nodejs ];
    text = ''
      exec node "${app}/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" "$@"
    '';
  };

  # config.services.postgresql.package has no value unless the server module is
  # enabled, so reaching for it unconditionally makes createLocally = false an
  # eval error rather than an external-database setup. Only psql and pg_isready
  # are needed here.
  psqlPackage =
    if cfg.database.createLocally then config.services.postgresql.package else pkgs.postgresql;

  preStart = pkgs.writeShellApplication {
    name = "sharetab-pre-start";
    runtimeInputs = [ psqlPackage pkgs.prisma ];
    text = ''
      # ExecStartPre runs before the database is necessarily accepting
      # connections, even with an After= ordering — postgresql.service counts
      # as started once the postmaster forks, not once it is ready.
      #
      # -d takes a full conninfo string, so this probes whatever DATABASE_URL
      # points at. Hardcoding -h /run/postgresql would make the probe fail
      # unconditionally against an external database.
      for _ in $(seq 1 30); do
        if pg_isready -d "$DATABASE_URL" -q; then break; fi
        sleep 1
      done
      pg_isready -d "$DATABASE_URL" -q

      applyLegacySql() {
        for sqlfile in "${app}"/prisma/migrations/*.sql; do
          [ -e "$sqlfile" ] || continue
          echo "Applying $(basename "$sqlfile")"
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$sqlfile"
        done
      }

      cd "${app}"

      tableCount=$(psql "$DATABASE_URL" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")

      # Hand-written SQL that prisma db push cannot express (enum conversions).
      # Upstream applies these with psql, not Prisma, and calls them idempotent
      # — but their guards test whether a *column* exists, not whether the
      # *table* does, so against an empty schema they fail on
      # `ALTER TABLE "GuestSplit"` before db push has created it.
      # (docker/entrypoint.sh runs them unconditionally and has the same
      # first-boot failure.)
      #
      # Reordering rather than skipping is what makes that safe. On an existing
      # database the conversions have to run first, or db push tries to change
      # the column type itself; on a fresh one db push goes first so the tables
      # exist, and each guard then correctly no-ops against the schema it just
      # created. Skipping the files outright on a fresh database — the obvious
      # fix — would silently defer any future migration that *does* need to run
      # on a new install until the second start.
      #
      # db push, never migrate deploy: there is no _prisma_migrations table.
      # No --skip-generate either — Prisma 7 removed the flag (db push no
      # longer runs generators) and passing it makes the CLI print usage and
      # exit 1. The client was generated at build time anyway, into a store
      # path that is read-only.
      if [ "$tableCount" -eq 0 ]; then
        echo "Fresh database — creating schema before legacy SQL migrations"
        prisma db push
        applyLegacySql
      else
        applyLegacySql
        prisma db push
      fi
    '';
  };
in
{
  options.services.sharetab = {
    enable = mkEnableOption "ShareTab, a self-hosted Splitwise alternative";

    package = mkOption {
      type = types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "The ShareTab package to run.";
    };

    domain = mkOption {
      type = types.str;
      example = "split.example.com";
      description = ''
        Public hostname the instance is served on. Used to derive NEXTAUTH_URL,
        which NextAuth needs to build absolute callback URLs correctly.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 3000;
      description = "Loopback port the Next.js server listens on.";
    };

    user = mkOption {
      type = types.str;
      default = "sharetab";
      description = "User the service runs as, and the PostgreSQL role it connects as.";
    };

    group = mkOption {
      type = types.str;
      default = "sharetab";
      description = "Group the service runs as.";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/sharetab";
      description = ''
        Persistent state: uploaded receipts and, when a subscription-backed AI
        provider is used, the Claude and ChatGPT OAuth credential stores.

        Also the service's HOME, which is not incidental — the Meridian proxy
        resolves its credential file from homedir() with no override.
      '';
    };

    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      example = "/run/secrets/sharetab.env";
      description = ''
        EnvironmentFile for secrets. NEXTAUTH_SECRET and AUTH_SECRET are
        mandatory — the app refuses to serve without them. AI provider keys,
        SMTP credentials and OAuth client secrets belong here too.
      '';
    };

    database.createLocally = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Provision the database and role in the system PostgreSQL cluster.

        When disabled, point database.url at an existing database; nothing else
        in this module assumes a local cluster.
      '';
    };

    database.name = mkOption {
      type = types.str;
      default = "sharetab";
      description = ''
        Database name. With createLocally enabled this must match
        services.sharetab.user, because the role is created with
        ensureDBOwnership.
      '';
    };

    database.url = mkOption {
      type = types.str;
      default = localDatabaseUrl;
      defaultText = lib.literalExpression ''"postgresql://''${cfg.user}@localhost/''${cfg.database.name}?host=/run/postgresql"'';
      example = "postgresql://sharetab@db.internal:5432/sharetab";
      description = ''
        Connection string for both the pre-start migrations and the app. The
        default connects to the local cluster over its unix socket with peer
        authentication.

        A URL with a password in it would land in the world-readable store; put
        DATABASE_URL in environmentFile instead, which overrides this.
      '';
    };

    settings = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        AI_PROVIDER_PRIORITY = "meridian";
        MAX_UPLOAD_SIZE_MB = "10";
      };
      description = ''
        Extra non-secret environment variables passed to the service. Secrets
        belong in environmentFile instead, so they stay out of the store.
      '';
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.database.createLocally -> cfg.database.name == cfg.user;
        message = ''
          services.sharetab.database.name ("${cfg.database.name}") must equal
          services.sharetab.user ("${cfg.user}") while
          services.sharetab.database.createLocally is enabled: the role is
          created with ensureDBOwnership, which requires a database of the same
          name. Set both options, or provision the database yourself and point
          services.sharetab.database.url at it.
        '';
      }
    ];

    services.postgresql = mkIf cfg.database.createLocally {
      enable = true;
      ensureDatabases = [ cfg.database.name ];
      ensureUsers = [
        {
          name = cfg.user;
          ensureDBOwnership = true;
        }
      ];
    };

    users.users.${cfg.user} = {
      isSystemUser = true;
      inherit (cfg) group;
      home = cfg.stateDir;
    };

    users.groups.${cfg.group} = { };

    # StateDirectory= would be simpler, but it is relative to /var/lib and so
    # cannot honour a stateDir pointing anywhere else — it would create
    # /var/lib/sharetab while every path below pointed somewhere never created,
    # and read-only under ProtectSystem=strict.
    systemd.tmpfiles.settings."10-sharetab" =
      let
        dir = {
          d = {
            inherit (cfg) user group;
            mode = "0700";
          };
        };
      in
      {
        "${cfg.stateDir}" = dir;
        "${cfg.stateDir}/uploads" = dir;
        "${cfg.stateDir}/uploads/receipts" = dir;
        "${cfg.stateDir}/.claude" = dir;
        "${cfg.stateDir}/chatgpt" = dir;
      };

    systemd.services.sharetab = {
      description = "ShareTab expense sharing";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];

      # postgresql.target, not postgresql.service: the role and database come
      # from postgresql-setup.service, a separate oneshot. Ordering against the
      # service alone lets the pre-start race it — pg_isready succeeds as soon
      # as the postmaster accepts connections, and psql then fails with
      # `role "sharetab" does not exist`. The target requires both units.
      after =
        [ "network-online.target" ]
        ++ lib.optional cfg.database.createLocally "postgresql.target";
      requires = lib.optional cfg.database.createLocally "postgresql.target";

      environment =
        {
          NODE_ENV = "production";
          PORT = toString cfg.port;

          # The reverse proxy is the only ingress; nothing should reach the
          # app directly even though the firewall already blocks it.
          HOSTNAME = "127.0.0.1";

          DATABASE_URL = cfg.database.url;
          NEXTAUTH_URL = "https://${cfg.domain}";

          # NextAuth v5 refuses to trust a forwarded Host header without this,
          # and every request arrives through the proxy.
          AUTH_TRUST_HOST = "true";

          UPLOAD_DIR = "${cfg.stateDir}/uploads";

          # Must stay $HOME/.claude. The app writes .credentials.json here,
          # but the Meridian proxy that later reads it resolves
          # `homedir() + "/.claude/.credentials.json"` with no env override —
          # so anything else completes the OAuth flow and then fails every
          # scan as unauthenticated. entrypoint.sh reconciles the two with a
          # symlink; naming the directory correctly is the same fix.
          CLAUDE_DIR = "${cfg.stateDir}/.claude";

          # entrypoint.sh sets this without exporting it, so the container
          # silently falls back to the hardcoded /app/chatgpt. Export it here.
          OPENAI_CODEX_DIR = "${cfg.stateDir}/chatgpt";

          HOME = cfg.stateDir;
        }
        // cfg.settings;

      path = [ claudeShim ];

      serviceConfig = {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = app;

        ExecStartPre = "${getExe preStart}";
        ExecStart = "${cfg.package.passthru.nodejs}/bin/node ${app}/server.js";

        EnvironmentFile = mkIf (cfg.environmentFile != null) cfg.environmentFile;

        # Carves stateDir back out of ProtectSystem=strict; tmpfiles above
        # creates it.
        ReadWritePaths = [ cfg.stateDir ];

        # Spaced at the width of systemd's default start-rate-limit window:
        # the default RestartSec of 100ms burns all five allowed starts in
        # about a second, so a slow PostgreSQL start would leave this
        # permanently failed instead of retrying until the socket appears.
        Restart = "on-failure";
        RestartSec = "10s";

        # DynamicUser and PrivateUsers are deliberately absent: peer auth
        # matches on a stable OS user name, and the credential stores under
        # stateDir need stable ownership across restarts.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        UMask = "0077";
      };
    };
  };
}
