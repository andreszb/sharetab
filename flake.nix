{
  description = "ShareTab — self-hosted, open-source Splitwise alternative with AI receipt scanning";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Dev database settings. These mirror scripts/dev.mjs and the DATABASE_URL
      # in .env.example so the Nix path and the npm path are interchangeable.
      pgPort = "51214";
      pgHost = "127.0.0.1";
      pgUser = "postgres";
      pgDatabase = "sharetab";

      # Toolchain versions are pinned to match .github/workflows/test.yml
      # (node 22, postgres 16) so Nix and CI cannot silently diverge.
      #
      # prisma-engines_7 provides bin/schema-engine, which `prisma db push` and
      # `prisma migrate` need: the npm @prisma/engines package downloads a
      # prebuilt, dynamically-linked binary that cannot execute on NixOS.
      # A query engine is deliberately absent — prisma/schema.prisma uses the
      # Rust-free `prisma-client` generator with @prisma/adapter-pg, so nothing
      # at runtime needs one.
      toolchain = pkgs: with pkgs; [
        nodejs_22
        postgresql_16
        prisma-engines_7
      ];

      # prisma-engines_7 ships a setup-hook that exports this, but setup hooks
      # only run for mkShell — a writeShellApplication merely gets the package
      # on PATH. Without an explicit export the CLI decides it must download an
      # engine for "linux-nixos", which does not exist, and dies on a 404. So
      # set it by hand and share the line between the shell and every app.
      prismaSchemaEngine = pkgs:
        "${pkgs.prisma-engines_7}/bin/schema-engine";

      # nixpkgs' playwright-driver and the npm playwright-core in
      # package-lock.json roll on independent schedules, so the browser
      # revisions they expect rarely match (at time of writing nixpkgs ships
      # chromium-1228, playwright-core 1.59.1 wants chromium-1217). Pointing
      # PLAYWRIGHT_BROWSERS_PATH straight at the store therefore fails with
      # "Executable doesn't exist".
      #
      # Instead build a writable symlink farm: mirror every browser nixpkgs
      # provides, then add an alias under the exact revision this checkout's
      # playwright-core asks for. Reading the revisions out of browsers.json at
      # runtime means an npm playwright bump needs no change here.
      playwrightBrowsersDir = ".playwright-browsers";

      linkPlaywrightBrowsers = pkgs: pkgs.writeShellApplication {
        name = "link-playwright-browsers";
        runtimeInputs = [ pkgs.nodejs_22 ];
        text = ''
          store="${pkgs.playwright-driver.browsers}"
          farm="$PWD/${playwrightBrowsersDir}"

          if [ ! -f node_modules/playwright-core/browsers.json ]; then
            echo "link-playwright-browsers: run 'npm install' first." >&2
            exit 1
          fi

          mkdir -p "$farm"

          # Mirror what nixpkgs ships, under its own revision names.
          for path in "$store"/*; do
            ln -sfn "$path" "$farm/$(basename "$path")"
          done

          # Playwright turns "chromium-headless-shell" into the directory name
          # "chromium_headless_shell-<revision>". Alias each browser this
          # checkout expects onto whatever revision nixpkgs actually built.
          node -e '
            const { browsers } = require("./node_modules/playwright-core/browsers.json");
            for (const b of browsers) {
              if (!b.installByDefault) continue;
              console.log(b.name.replace(/-/g, "_") + " " + b.revision);
            }
          ' | while read -r name revision; do
            actual="$(find "$store" -maxdepth 1 -name "$name-*" -print -quit)"
            if [ -n "$actual" ]; then
              ln -sfn "$actual" "$farm/$name-$revision"
            else
              echo "link-playwright-browsers: nixpkgs has no build of '$name'; skipping." >&2
            fi
          done

          # Playwright refuses to start if this marker is missing.
          touch "$farm/.links"
          echo "link-playwright-browsers: linked into $farm"
        '';
      };

      # Boot a local PostgreSQL against ./test-pg-data, push the schema, seed,
      # then run `next dev` — the Nix equivalent of `npm run dev:full`.
      #
      # scripts/dev.mjs cannot be used on NixOS: it drives the npm package
      # `embedded-postgres`, whose prebuilt binaries are dynamically linked
      # against an FHS layout and will not execute.
      devScript = pkgs: pkgs.writeShellApplication {
        name = "sharetab-dev";
        runtimeInputs = toolchain pkgs;
        text = ''
          if [ ! -f package.json ]; then
            echo "sharetab-dev: run this from the repository root." >&2
            exit 1
          fi

          export PRISMA_SCHEMA_ENGINE_BINARY="${prismaSchemaEngine pkgs}"

          PGDATA="$PWD/test-pg-data"
          export PGDATA
          export PGPORT="${pgPort}"
          export PGHOST="${pgHost}"
          export PGUSER="${pgUser}"

          if [ ! -d "$PGDATA" ]; then
            echo "==> Initialising PostgreSQL cluster in $PGDATA"
            # --locale=C keeps this off glibcLocales; dev data does not depend
            # on collation. --auth=trust is safe here because the server only
            # ever listens on loopback, and it makes the password in
            # DATABASE_URL a no-op.
            initdb --username="${pgUser}" --auth=trust --encoding=UTF8 --locale=C >/dev/null
          fi

          socket="$(mktemp -d)"

          cleanup() {
            echo ""
            echo "==> Shutting down PostgreSQL"
            pg_ctl stop -m fast -s 2>/dev/null || true
            rm -rf "$socket"
          }
          trap cleanup EXIT

          echo "==> Starting PostgreSQL on ${pgHost}:${pgPort}"
          pg_ctl start -w -s \
            -l "$PGDATA/postmaster.log" \
            -o "-p ${pgPort} -h ${pgHost} -k $socket"

          createdb -h "${pgHost}" -p "${pgPort}" -U "${pgUser}" "${pgDatabase}" 2>/dev/null \
            || true

          # Real environment variables win over .env under dotenv and Next.js,
          # so this makes the dev database authoritative without editing .env.
          export DATABASE_URL="postgresql://${pgUser}:${pgUser}@${pgHost}:${pgPort}/${pgDatabase}"

          if [ ! -f .env ]; then
            echo "sharetab-dev: no .env found — copy .env.example and set" >&2
            echo "              NEXTAUTH_SECRET and AUTH_SECRET before logging in." >&2
          fi

          if [ ! -d node_modules ]; then
            echo "==> Installing npm dependencies"
            npm install
          fi

          echo "==> Pushing Prisma schema"
          npx prisma db push

          echo "==> Seeding demo data"
          npm run db:seed || echo "sharetab-dev: seed skipped (data already present?)"

          echo ""
          echo "==> Starting Next.js dev server on http://localhost:3000"
          npx next dev
        '';
      };

      # Thin wrappers so `nix run` works without entering the shell first.
      npmScript = pkgs: name: script: pkgs.writeShellApplication {
        inherit name;
        runtimeInputs = toolchain pkgs;
        text = ''
          if [ ! -f package.json ]; then
            echo "${name}: run this from the repository root." >&2
            exit 1
          fi
          export PRISMA_SCHEMA_ENGINE_BINARY="${prismaSchemaEngine pkgs}"
          if [ ! -d node_modules ]; then
            npm install
          fi
          exec npm run ${script}
        '';
      };
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = toolchain pkgs ++ [
            (linkPlaywrightBrowsers pkgs)
            (devScript pkgs)
          ];

          PRISMA_SCHEMA_ENGINE_BINARY = prismaSchemaEngine pkgs;

          # Browsers come from the symlink farm built by
          # link-playwright-browsers; never let npm download its own.
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH="$PWD/${playwrightBrowsersDir}"

            echo "ShareTab dev shell — node $(node --version), postgres $(psql --version | cut -d' ' -f3)"
            echo "  npm install            install dependencies (not vendored by this flake)"
            echo "  sharetab-dev           postgres + schema + seed + next dev"
            echo "  link-playwright-browsers   wire up e2e browsers (after npm install)"
          '';
        };
      });

      apps = forAllSystems (pkgs:
        let
          mkApp = description: drv: {
            type = "app";
            program = nixpkgs.lib.getExe drv;
            meta = { inherit description; };
          };
          dev = mkApp "PostgreSQL + schema push + seed + Next.js dev server" (devScript pkgs);
        in
        {
          inherit dev;
          default = dev;
          build = mkApp "Production build (npm run build)"
            (npmScript pkgs "sharetab-build" "build");
          test = mkApp "Unit tests (vitest)"
            (npmScript pkgs "sharetab-test" "test");
        });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
