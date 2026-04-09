# Windows desktop release

This project includes a Windows-first desktop packaging pipeline inspired by the local signing / installer flow used in UniGit.

## What it produces

- A desktop executable at `src-tauri/target/release/vol3d.exe`
- An NSIS installer under `src-tauri/target/release/bundle/nsis/`
- Optional local code-signing using a self-signed certificate in the current user's certificate store

## Local release flow

### 1. Create or reuse a self-signed code-signing certificate

```powershell
npm run release:windows:cert
```

To also export a `.pfx` for CI or backup, pass a password argument:

```powershell
npm run release:windows:cert -- my-password
```

That writes the certificate to `./certificates/vol3d-self-signed.pfx`.

### 2. Build a signed Windows release

```powershell
npm run release:windows
```

This sets `VOL3D_REQUIRE_SIGNING=1`, builds the Tauri app, signs the generated binaries with `signtool.exe`, and creates the NSIS installer.

## Useful environment variables

- `VOL3D_SIGN_SUBJECT` - certificate subject to search for
- `VOL3D_CERT_THUMBPRINT` - explicit certificate thumbprint override
- `VOL3D_TIMESTAMP_URL` - optional RFC3161 timestamp URL
- `VOL3D_REQUIRE_SIGNING=1` - fail the build when no certificate or signtool is available

## CI signing

For GitHub Actions, import a base64-encoded `.pfx` into `Cert:\CurrentUser\My` before running `npm run release:windows`.

## Notes

- A self-signed certificate is useful for internal/test distribution, but Windows SmartScreen reputation warnings can still appear.
- The signing scripts expect the Windows SDK signing tools (`signtool.exe`) to be installed.

