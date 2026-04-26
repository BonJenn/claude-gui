# Release Process

Blackcrab publishes installers with GitHub Releases. The release workflow builds
macOS, Windows, and Linux artifacts, uploads them to a draft release, and
generates Tauri updater artifacts plus `latest.json`.

## Versioning

Use semver-style versions.

- Patch: bug fixes and documentation.
- Minor: new user-visible features.
- Major: breaking changes after 1.0.

Pre-1.0, minor versions may still contain breaking changes. Call them out in
release notes.

## Checklist

1. Confirm the working tree only contains intended changes.
2. Run checks:

   ```sh
   npm ci
   npm run check
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/blackcrab-updater.key)" \
     TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
     env LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run tauri -- build
   ```

3. Update versions in:

   - `package.json`
   - `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`

4. Update `ROADMAP.md` if priorities changed.
5. Draft release notes with:

   - Highlights.
   - Fixes.
   - Known issues.
   - Upgrade notes.

6. Commit the version bump.
7. Tag the release:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

8. Wait for the `release` GitHub Actions workflow to finish.
9. Download and test the draft release artifacts.
10. Publish the draft release when the installers are good.

The workflow can also be run manually from GitHub Actions with a tag input.

## Required GitHub Secrets

Updater signing is required whenever `createUpdaterArtifacts` is enabled.

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of the private updater key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional. Leave empty for the current
  local key unless you generated a key with a non-empty password.

The public updater key is committed in `src-tauri/tauri.conf.json`. Never commit
the private key.

The current local private key was generated at:

```text
~/.tauri/blackcrab-updater.key
```

Set the GitHub secret from that file:

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY -R BonJenn/blackcrab < ~/.tauri/blackcrab-updater.key
```

## macOS Signing and Notarization

Unsigned macOS builds work for testing, but public browser downloads should be
signed and notarized to avoid Gatekeeper warnings.

The release workflow requires Apple signing and notarization secrets on the
macOS runner. The local machine currently has this Developer ID identity:

```text
Developer ID Application: Jonathan Benn (YF28W3NGG6)
```

Use a paid Apple Developer Program account. Free Apple Developer accounts can
sign development builds, but cannot notarize public Developer ID downloads.

### Export the Developer ID Certificate

1. Open Keychain Access.
2. Select the `login` keychain and `My Certificates`.
3. Find `Developer ID Application: Jonathan Benn (YF28W3NGG6)`.
4. Expand it, right-click the private key entry, and export it as a `.p12`.
5. Use a strong export password and keep the `.p12` out of the repo.

### Configure GitHub Secrets

Use the helper script so secrets go directly to GitHub instead of through chat.

With Apple ID notarization:

```sh
APPLE_CERTIFICATE_P12=~/Desktop/blackcrab-developer-id.p12 \
  APPLE_ID=you@example.com \
  ./scripts/configure-macos-signing-secrets.sh
```

The script prompts for the `.p12` export password and your Apple
app-specific password.

With App Store Connect API-key notarization:

```sh
APPLE_CERTIFICATE_P12=~/Desktop/blackcrab-developer-id.p12 \
  APPLE_API_KEY=KEYID12345 \
  APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000 \
  APPLE_API_KEY_P8_PATH=~/Downloads/AuthKey_KEYID12345.p8 \
  ./scripts/configure-macos-signing-secrets.sh
```

The workflow supports these GitHub Actions secrets:

- `APPLE_CERTIFICATE`: base64-encoded `.p12` Developer ID Application
  certificate.
- `APPLE_CERTIFICATE_PASSWORD`: password for the `.p12` certificate.
- `APPLE_SIGNING_IDENTITY`: signing identity name, usually a Developer ID
  Application identity.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_PASSWORD`: app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.
- `APPLE_API_KEY`: App Store Connect API key ID.
- `APPLE_API_ISSUER`: App Store Connect issuer ID.
- `APPLE_API_KEY_P8`: contents of the downloaded `AuthKey_*.p8` file.

The release workflow passes those secrets to Tauri automatically. On macOS, the
workflow fails if the certificate or notarization credentials are missing. Tauri
notarizes and staples the `.app`; the workflow then notarizes, staples, verifies,
and re-uploads the `.dmg` so the website download is accepted by Gatekeeper too.

After downloading a draft macOS release, verify it locally:

```sh
spctl -a -vv -t open Blackcrab_0.1.0_aarch64.dmg
xcrun stapler validate Blackcrab_0.1.0_aarch64.dmg
```

## Tauri Auto-Update

The app checks:

```text
https://github.com/BonJenn/blackcrab/releases/latest/download/latest.json
```

When a newer version is available, Blackcrab shows an update banner. Installing
the update downloads the signed updater artifact and relaunches the app.

The updater only works for users who installed a build produced with the same
public updater key in `tauri.conf.json`.

## Download Counts

GitHub tracks release asset download counts. To inspect them:

```sh
gh api repos/BonJenn/blackcrab/releases \
  --jq '.[] | {tag: .tag_name, assets: [.assets[] | {name, downloads: .download_count}]}'
```

The landing site tracks download button clicks separately with Vercel Analytics.
Use both numbers:

- Landing analytics: how many users clicked download.
- GitHub release counts: how many installer assets were actually downloaded.
