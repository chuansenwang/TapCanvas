# Native Agent P0 Toolchain

This isolated toolchain is used only for P0 Runtime and Host validation.

- Node: `>=24.0.0`
- pnpm: `11.0.0`
- TypeScript: `6.0.3`

It is intentionally outside the workspace package graph and must not upgrade the root workspace toolchain.
