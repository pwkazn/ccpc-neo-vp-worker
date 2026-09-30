{
  description = "CCPC Neo VP —— 基于 RankLand 榜单数据的 CCPC 新赛制实时榜单模拟器";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
      pkgsFor = system: nixpkgs.legacyPackages.${system};

      # Source files that make up the runtime, shared by the package and the
      # dev shell so both always run the same code.
      runtimeFiles = [
        "package.json"
        "server"
        "shared"
        "web"
      ];
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          nodejs = pkgs.nodejs_22;

          # The application is plain ESM with no runtime dependencies, so it can
          # be installed with a trivial derivation instead of a build step.
          ccpc-neo-vp = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "ccpc-neo-vp";
            version = "0.1.0";
            src = self;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            # No configure/build step: this is interpreted JavaScript.
            dontBuild = true;

            installPhase = ''
              runHook preInstall

              appDir="$out/share/ccpc-neo-vp"
              mkdir -p "$appDir"
              for f in ${builtins.concatStringsSep " " runtimeFiles}; do
                cp -r "$f" "$appDir/"
              done

              mkdir -p "$out/bin"
              makeWrapper ${nodejs}/bin/node "$out/bin/ccpc-neo-vp" \
                --add-flags "$appDir/server/index.mjs" \
                --set-default PORT 5173 \
                --set-default HOST 127.0.0.1

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = "CCPC 新赛制实时榜单模拟器（RankLand 数据回放）";
              license = licenses.mit;
              mainProgram = "ccpc-neo-vp";
              platforms = platforms.unix;
            };
          });
        in
        {
          default = ccpc-neo-vp;
          ccpc-neo-vp = ccpc-neo-vp;
        });

      apps = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/ccpc-neo-vp";
            # Passing extra arguments works: `nix run . -- --port 8080`.
            meta.description = "启动 CCPC Neo VP 服务并打开网页";
          };

          # Run the test suite without installing anything.
          test = {
            type = "app";
            program = "${pkgs.writeShellApplication {
              name = "ccpc-neo-vp-test";
              runtimeInputs = [ pkgs.nodejs_22 ];
              text = ''
                cd ${self}
                exec node --test
              '';
            }}/bin/ccpc-neo-vp-test";
            meta.description = "运行单元测试";
          };

          # Run the network-dependent regression against live RankLand data.
          test-e2e = {
            type = "app";
            program = "${pkgs.writeShellApplication {
              name = "ccpc-neo-vp-test-e2e";
              runtimeInputs = [ pkgs.nodejs_22 pkgs.curl ];
              text = ''
                cd ${self}
                export VP_E2E=1
                exec node --test test/e2e.test.mjs
              '';
            }}/bin/ccpc-neo-vp-test-e2e";
            meta.description = "运行真实数据回归测试（需要网络）";
          };
        });

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.jq
              pkgs.curl
            ];
            shellHook = ''
              echo "ccpc-neo-vp 开发环境"
              echo "  node $(node --version)"
              echo "  npm run start    # 启动服务 (默认 http://127.0.0.1:5173)"
              echo "  npm test         # 运行测试"
              echo "  npm run test:e2e # 运行真实数据回归（需要网络）"
            '';
          };
        });

      # `nix flake check` runs the offline test suite.
      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          tests = pkgs.runCommand "ccpc-neo-vp-tests"
            {
              nativeBuildInputs = [ pkgs.nodejs_22 ];
              src = self;
            } ''
            cp -r $src/. .
            chmod -R u+w .
            HOME=$TMPDIR XDG_CACHE_HOME=$TMPDIR/cache node --test 2>&1 | tee $out
          '';
        });

      formatter = forAllSystems (system: (pkgsFor system).nixpkgs-fmt);
    };
}
