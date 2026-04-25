# Release Process

Blackcrab does not have a fully automated signed release pipeline yet. Until it
does, use this checklist for tagged releases.

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
   npm run tauri -- build
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

6. Tag the release:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

7. Create a GitHub Release and attach built artifacts.

## Future Automation

Add signed, per-platform Tauri release workflows once the app has stable
signing credentials and tested packaging for macOS, Linux, and Windows.
