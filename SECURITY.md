# Security

`assay-mcp` holds a key that can sign payments. Please report anything that could let someone else use that key, raise a limit, or make it sign a payment the guards should refuse.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue.

Please include the version, your OS, the steps to reproduce, and the impact you expect. We aim to acknowledge a report within 3 business days.

## Supported versions

Only the latest published version of `@assay-ai/mcp` gets security fixes. There is no self-update, so update by changing the pinned version in your install command.

## Verifying a release

Each release is published from this repository by GitHub Actions, through a protected environment with a required reviewer, from a signed tag, with npm trusted publishing and provenance.

1. Check provenance. Install the exact version in an empty folder, then run `npm audit signatures`:

   ```sh
   npm install --ignore-scripts @assay-ai/mcp@<version>
   npm audit signatures
   ```

   The npm page of the version shows the provenance statement. It links to the workflow run and the source commit.
2. Check the commit. The provenance commit must be the commit of the signed tag `v<version>` in this repository (`git tag -v v<version>`).
3. Check the content. The package contains only `package.json`, `README.md` and `dist/cli.js`. Its only dependency is `@napi-rs/keyring` at an exact version, and it has no install scripts.
4. Check the install command. The command your app or the Assay web app shows must match the one in [README.md](README.md).
