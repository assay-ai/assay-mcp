# Placeholder packages

These packages reserve npm names that look like `@goassay-ai/mcp`: `goassay-mcp`, `goassay-ai-mcp`, `@goassay/mcp` (folder `goassay__mcp`). `goassaymcp` needs no placeholder: npm refuses it as too similar to `goassay-mcp`. The unscoped `assay-mcp` belongs to a third party (README, residual risk T11). Each one has no code, no dependencies and no scripts, and its README points to `@goassay-ai/mcp`.

They are published by hand, once, by the npm organisation owner. The release workflow never publishes them.

`bootstrap-goassay-ai-mcp` is an empty `@goassay-ai/mcp@0.0.0-bootstrap.0`, published by hand once (with `--tag bootstrap`) so npm trusted publishing can be configured for the real package, then deprecated.
