# Third-party notices

The plugins under `packages/` are refactored from the MIT-licensed packages of
[magpie-community/plugins](https://github.com/magpie-community/plugins) (npm: `@magpie-community/*`), whose
copyright notice is kept in every published package's `LICENSE` (`licenses/MIT.txt`):

> Copyright (c) 2026 magpie-community contributors

Each package's `package.json` records the upstream package and version it was taken from (`upstream`), and its
README says so. `packages/qoder` also ships `LICENSE-CLIProxyAPI`, the notice upstream carries for code it adapts.

Licensing here: `kit/` and `scripts/` are this repository's own and fall under the repository `LICENSE`
(Apache-2.0). The published plugin packages contain upstream's MIT code with this repository's changes and are
distributed under MIT, with both copyright lines.
