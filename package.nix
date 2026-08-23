# Production build of the ShareTab Next.js app.
#
# npm install scripts are the whole difficulty here. The one that matters is
# @prisma/engines, whose postinstall downloads a prebuilt, dynamically-linked
# schema engine that does not exist for "linux-nixos" — it 404s against
# binaries.prisma.sh. importNpmLock's hook installs with --ignore-scripts, and
# the deployed unit uses the nixpkgs Prisma CLI instead, which carries its own
# engine.
#
# importNpmLock is used rather than buildNpmPackage on purpose: it derives
# every fetch from the `integrity` fields already in package-lock.json, so
# there is no npmDepsHash to go stale when a dependency is bumped.
{ lib
, stdenv
, nodejs_22
, fetchurl
, importNpmLock
, prisma-engines_7
, inter
, jetbrains-mono
,
}:
let
  nodejs = nodejs_22;

  # Keep the store path stable across edits to files the build never reads —
  # notably the e2e suite, the dev database and any local build output.
  src = lib.cleanSourceWith {
    src = ./.;
    name = "sharetab-source";
    filter = path: _type:
      !(builtins.elem (baseNameOf path) [
        "node_modules"
        ".next"
        ".git"
        "test-pg-data"
        ".playwright-browsers"
        "result"
        "uploads"
      ]);
  };
in
stdenv.mkDerivation {
  pname = "sharetab";
  version = (lib.importJSON ./package.json).version;

  inherit src;

  nativeBuildInputs = [
    nodejs
    # No npmConfigHook / linkNodeModulesHook here — see preBuild.
  ];

  npmDeps = importNpmLock.buildNodeModules {
    npmRoot = src;
    inherit nodejs;

    # @anthropic-ai/sdk is pinned twice in package.json: once as a direct
    # dependency and once in `overrides`, where it forces every transitive
    # copy to the same major. importNpmLock rewrites `dependencies` and
    # `devDependencies` to file:/nix/store/*.tgz paths but leaves `overrides`
    # alone, so npm ends up comparing a file: path against "^0.93.0" and
    # dies with EOVERRIDE.
    #
    # Deleting the override is NOT the fix — it is load-bearing for the
    # transitive copies, and without it npm resolves that range against the
    # registry, which the sandbox has no access to (ENOTCACHED).
    #
    # So rewrite it to the very same tarball importNpmLock will use, fetched
    # exactly the way its own fetchModule does (fetchurl on the lockfile's
    # `resolved` + `integrity`), which yields an identical store path. Read
    # straight out of package-lock.json so a version bump needs no edit here.
    package =
      let
        pkgJson = lib.importJSON ./package.json;
        lock = lib.importJSON ./package-lock.json;
        sdk = lock.packages."node_modules/@anthropic-ai/sdk";
        sdkTarball = fetchurl {
          url = sdk.resolved;
          hash = sdk.integrity;
        };
      in
      pkgJson
      // {
        overrides =
          pkgJson.overrides
          // {
            "@anthropic-ai/sdk" = "file:${sdkTarball}";
          };
      };

    derivationArgs = {
      # next-auth@5 beta declares a peerOptional on an older nodemailer.
      # .npmrc sets this too, but the hook installs from a patched copy of
      # package.json, so state it explicitly.
      npmFlags = [ "--legacy-peer-deps" ];
    };
  };


  # next/font/google downloads Inter and JetBrains Mono from Google at build
  # time, which a sandboxed build cannot do — the build fails with "Failed to
  # fetch `Inter` from Google Fonts". Swap both for next/font/local backed by
  # the nixpkgs font packages.
  #
  # This is a Nix-build-only substitution: the repo keeps next/font/google for
  # `npm run dev` and for docker/Dockerfile. Either route self-hosts the fonts
  # in the built output, so this only changes where the bytes come from at
  # build time, not how the app serves them.
  postPatch = ''
          fontDir="src/app/[locale]/fonts"
          mkdir -p "$fontDir"
          cp ${inter}/share/fonts/truetype/InterVariable.ttf "$fontDir/InterVariable.ttf"
          cp "${jetbrains-mono}/share/fonts/WOFF2/JetBrainsMono[wght].woff2" \
            "$fontDir/JetBrainsMono-Variable.woff2"
          chmod u+w "$fontDir"/*

          substituteInPlace "src/app/[locale]/layout.tsx" \
            --replace-fail \
              "import { Inter, JetBrains_Mono } from 'next/font/google';" \
              "import localFont from 'next/font/local';" \
            --replace-fail \
              "const inter = Inter({
      variable: '--font-inter',
      subsets: ['latin'],
      display: 'swap',
    });" \
              "const inter = localFont({
      src: './fonts/InterVariable.ttf',
      variable: '--font-inter',
      display: 'swap',
    });" \
            --replace-fail \
              "const jetbrainsMono = JetBrains_Mono({
      variable: '--font-jetbrains-mono',
      subsets: ['latin'],
      display: 'swap',
    });" \
              "const jetbrainsMono = localFont({
      src: './fonts/JetBrainsMono-Variable.woff2',
      variable: '--font-jetbrains-mono',
      display: 'swap',
    });"
  '';

  # next.config.ts keys `output: "standalone"` on this exact value.
  DOCKER_BUILD = "1";
  NEXT_TELEMETRY_DISABLED = "1";

  # Set so the Prisma CLI never concludes it has to fetch an engine.
  PRISMA_SCHEMA_ENGINE_BINARY = "${prisma-engines_7}/bin/schema-engine";
  PRISMA_SKIP_POSTINSTALL_GENERATE = "1";

  # The hooks are deliberately unused: npmConfigHook would re-run npm
  # install (and hit the override conflict again), and linkNodeModulesHook
  # symlinks each entry into the store, which Turbopack rejects.
  dontLinkNodeModules = true;

  preBuild = ''
    # Turbopack resolves realpaths and then refuses anything that lands
    # outside the project — with a symlinked tree it decides the workspace
    # root is /nix/store and aborts with "couldn't find the Next.js
    # package". Materialise a real node_modules instead: the same shape
    # docker/Dockerfile builds against, at the cost of one copy. The store
    # tree is already real dirs with relative .bin symlinks, so a plain
    # cp -r is right — --dereference would flatten .bin/prisma into a
    # standalone file that can no longer find its sibling .wasm.
    cp -r "$npmDeps/node_modules" node_modules
    # Store files come out read-only; the build writes into node_modules
    # (.cache, .prisma) so it needs them writable. Execute bits must survive,
    # which is why this is a chmod rather than --no-preserve=mode.
    chmod -R u+w node_modules

    export PATH="$PWD/node_modules/.bin:$PATH"
  '';

  buildPhase = ''
    runHook preBuild

    # src/generated/prisma is gitignored, so the client must be generated
    # here. The `prisma-client` generator is Rust-free — this writes
    # TypeScript, it does not need a query engine.
    prisma generate

    next build

    runHook postBuild
  '';

  # Mirrors the runner stage of docker/Dockerfile.
  installPhase = ''
    runHook preInstall

    app="$out/share/sharetab"
    mkdir -p "$app"

    # The standalone bundle carries its own traced node_modules and the
    # server.js entrypoint; it unpacks at the app root.
    cp -r .next/standalone/. "$app/"
    mkdir -p "$app/.next"
    cp -r .next/static "$app/.next/static"
    # `cp -r public "$app/public"` would nest as public/public: the standalone
    # bundle already ships these directories. Copy contents, not the dir.
    mkdir -p "$app/public"
    cp -r public/. "$app/public/"

    # Needed by the pre-start migration step, not by the server.
    mkdir -p "$app/prisma"
    cp -r prisma/. "$app/prisma/"
    mkdir -p "$app/src/generated"
    cp -r src/generated/. "$app/src/generated/"

    # A deploy-time Prisma config with no imports.
    #
    # The repo's own prisma.config.ts does `import 'dotenv/config'` and
    # `import { defineConfig } from 'prisma/config'`, neither of which
    # resolves from a store path — prisma is a devDependency and is not in
    # the standalone bundle. Prisma 7 removed `url` from schema files
    # entirely, so a config file is mandatory and this is the smallest one
    # that works; it only needs the default export. DATABASE_URL comes from
    # the systemd unit, so dotenv has nothing left to do.
    cat > "$app/prisma.config.ts" <<'PRISMACONFIG'
    export default {
      schema: 'prisma/schema.prisma',
      migrations: { path: 'prisma/migrations' },
      datasource: { url: process.env['DATABASE_URL'] },
    };
    PRISMACONFIG
    sed -i 's/^      //' "$app/prisma.config.ts"

    # next.config.ts lists these two in serverExternalPackages, so Next does
    # not trace them into the standalone bundle and they have to be carried
    # over by hand (docker/Dockerfile does the same). The Meridian provider
    # and the Claude Agent SDK are what the Claude Max / ChatGPT
    # subscription login path runs on.
    mkdir -p "$app/node_modules/@rynfar" "$app/node_modules/@anthropic-ai"
    cp -r node_modules/@rynfar/meridian "$app/node_modules/@rynfar/"
    cp -r node_modules/@anthropic-ai/claude-agent-sdk "$app/node_modules/@anthropic-ai/"

    runHook postInstall
  '';

  passthru = {
    inherit nodejs;
  };

  meta = {
    description = "Self-hosted, open-source Splitwise alternative with AI receipt scanning";
    homepage = "https://github.com/andreszb/sharetab";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
