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

  # Peer auth over the socket: PostgreSQL matches the OS user name against the
  # database role, which is why the unit runs as a static user rather than
  # under DynamicUser. `user=` is not optional — without it libpq connects as
  # whatever the process's uid maps to only when it can resolve it, and the
  # failure mode is an "anonymous" role that does not exist.
  databaseUrl = "postgresql:///${cfg.database.name}?host=/run/postgresql&user=${cfg.user}";

  # Replaces docker/claude. The Claude Agent SDK shells out to an executable
  # literally named `claude`, so it has to be resolvable on PATH; it also
  # insists on a writable HOME, which is the unit's StateDirectory.
  claudeShim = pkgs.writeShellApplication {
    name = "claude";
    runtimeInputs = [ cfg.package.passthru.nodejs ];
    text = ''
      exec node "${app}/node_modules/@anthropic-ai/claude-agent-sdk/cli.js" "$@"
    '';
  };

  preStart = pkgs.writeShellApplication {
    name = "sharetab-pre-start";
    runtimeInputs = [ config.services.postgresql.package pkgs.prisma ];
    text = ''
      # ExecStartPre runs before postgresql.service is necessarily accepting
      # connections, even with an After= ordering — the unit is considered
      # started once the postmaster forks, not once it is ready.
      for _ in $(seq 1 30); do
        if pg_isready -h /run/postgresql -q; then break; fi
        sleep 1
      done
      pg_isready -h /run/postgresql -q

      # Hand-written SQL that prisma db push cannot express (enum conversions).
      # Upstream applies these with psql, not Prisma, and calls them
      # idempotent — but that means safe to re-run against a database that
      # already has the tables. Their guards test whether a *column* exists,
      # not whether the *table* does, so against a fresh database the file
      # fails on `ALTER TABLE "GuestSplit"` before db push has created it.
      #
      # On an empty schema these conversions are not merely skippable, they
      # are meaningless: db push creates the tables with the enum already in
      # place. So apply them only to a database that has been initialised.
      # (docker/entrypoint.sh runs them unconditionally and has the same
      # first-boot failure.)
      tableCount=$(psql "$DATABASE_URL" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")

      if [ "$tableCount" -eq 0 ]; then
        echo "Fresh database — skipping legacy SQL migrations"
      else
        for sqlfile in "${app}"/prisma/migrations/*.sql; do
          [ -e "$sqlfile" ] || continue
          echo "Applying $(basename "$sqlfile")"
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$sqlfile"
        done
      fi

      # db push, never migrate deploy — there is no _prisma_migrations table.
      # --skip-generate because the client was generated at build time and the
      # store path is read-only.
      cd "${app}"
      prisma db push --skip-generate
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
      description = "Provision the database and role in the system PostgreSQL cluster.";
    };

    database.name = mkOption {
      type = types.str;
      default = "sharetab";
      description = "Database name.";
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

    systemd.services.sharetab = {
      description = "ShareTab expense sharing";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after =
        [ "network-online.target" ]
        ++ lib.optional cfg.database.createLocally "postgresql.service";
      requires = lib.optional cfg.database.createLocally "postgresql.service";

      environment =
        {
          NODE_ENV = "production";
          PORT = toString cfg.port;

          # The reverse proxy is the only ingress; nothing should reach the
          # app directly even though the firewall already blocks it.
          HOSTNAME = "127.0.0.1";

          DATABASE_URL = databaseUrl;
          NEXTAUTH_URL = "https://${cfg.domain}";

          # NextAuth v5 refuses to trust a forwarded Host header without this,
          # and every request arrives through the proxy.
          AUTH_TRUST_HOST = "true";

          UPLOAD_DIR = "${cfg.stateDir}/uploads";
          CLAUDE_DIR = "${cfg.stateDir}/claude";

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

        StateDirectory = "sharetab sharetab/uploads sharetab/uploads/receipts sharetab/claude sharetab/chatgpt";
        StateDirectoryMode = "0700";

        # Spaced at the width of systemd's default start-rate-limit window:
        # the default RestartSec of 100ms burns all five allowed starts in
        # about a second, so a slow PostgreSQL start would leave this
        # permanently failed instead of retrying until the socket appears.
        Restart = "on-failure";
        RestartSec = "10s";

        # DynamicUser and PrivateUsers are deliberately absent: peer auth
        # matches on a stable OS user name, and the credential stores under
        # StateDirectory need stable ownership across restarts.
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
