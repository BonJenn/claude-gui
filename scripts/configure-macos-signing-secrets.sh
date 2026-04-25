#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:-BonJenn/blackcrab}"
team_id="${APPLE_TEAM_ID:-YF28W3NGG6}"
signing_identity="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Jonathan Benn (YF28W3NGG6)}"

usage() {
  cat <<'EOF'
Configure GitHub Actions secrets for signed and notarized macOS releases.

Required:
  APPLE_CERTIFICATE_P12=/path/to/developer-id-application.p12

Choose one notarization method:
  Apple ID app-specific password:
    APPLE_ID=you@example.com
    APPLE_TEAM_ID=YF28W3NGG6

  App Store Connect API key:
    APPLE_API_KEY=KEYID12345
    APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000
    APPLE_API_KEY_P8_PATH=/path/to/AuthKey_KEYID12345.p8

Optional:
  APPLE_CERTIFICATE_PASSWORD=...   Export password for the .p12 file
  APPLE_PASSWORD=...               Apple app-specific password
  APPLE_SIGNING_IDENTITY=...       Defaults to Blackcrab's local Developer ID identity
  GITHUB_REPOSITORY=owner/repo     Defaults to BonJenn/blackcrab

Examples:
  APPLE_CERTIFICATE_P12=~/Desktop/blackcrab-developer-id.p12 \
    APPLE_ID=you@example.com \
    ./scripts/configure-macos-signing-secrets.sh

  APPLE_CERTIFICATE_P12=~/Desktop/blackcrab-developer-id.p12 \
    APPLE_API_KEY=KEYID12345 \
    APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000 \
    APPLE_API_KEY_P8_PATH=~/Downloads/AuthKey_KEYID12345.p8 \
    ./scripts/configure-macos-signing-secrets.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required. Install GitHub CLI and authenticate with: gh auth login" >&2
  exit 1
fi

if [[ -z "${APPLE_CERTIFICATE_P12:-}" ]]; then
  usage >&2
  echo >&2
  echo "APPLE_CERTIFICATE_P12 is required." >&2
  exit 1
fi

if [[ ! -f "$APPLE_CERTIFICATE_P12" ]]; then
  echo "Certificate file not found: $APPLE_CERTIFICATE_P12" >&2
  exit 1
fi

if [[ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
  read -rsp "Password used when exporting the .p12 certificate: " APPLE_CERTIFICATE_PASSWORD
  echo
fi

has_apple_id_auth=0
if [[ -n "${APPLE_ID:-}" ]]; then
  has_apple_id_auth=1
  if [[ -z "${APPLE_PASSWORD:-}" ]]; then
    read -rsp "Apple app-specific password for $APPLE_ID: " APPLE_PASSWORD
    echo
  fi
fi

has_api_key_auth=0
if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_ISSUER:-}" || -n "${APPLE_API_KEY_P8_PATH:-}" ]]; then
  has_api_key_auth=1
  if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_ISSUER:-}" || -z "${APPLE_API_KEY_P8_PATH:-}" ]]; then
    echo "APPLE_API_KEY, APPLE_API_ISSUER, and APPLE_API_KEY_P8_PATH must be provided together." >&2
    exit 1
  fi
  if [[ ! -f "$APPLE_API_KEY_P8_PATH" ]]; then
    echo "API key file not found: $APPLE_API_KEY_P8_PATH" >&2
    exit 1
  fi
fi

if [[ "$has_apple_id_auth" -eq 0 && "$has_api_key_auth" -eq 0 ]]; then
  usage >&2
  echo >&2
  echo "Provide either Apple ID notarization variables or App Store Connect API key variables." >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

certificate_base64="$tmp_dir/apple-certificate-base64.txt"
openssl base64 -A -in "$APPLE_CERTIFICATE_P12" -out "$certificate_base64"

echo "Setting Apple signing secrets for $repo..."
gh secret set APPLE_CERTIFICATE -R "$repo" < "$certificate_base64" >/dev/null
printf '%s' "$APPLE_CERTIFICATE_PASSWORD" | gh secret set APPLE_CERTIFICATE_PASSWORD -R "$repo" >/dev/null
printf '%s' "$signing_identity" | gh secret set APPLE_SIGNING_IDENTITY -R "$repo" >/dev/null

if [[ "$has_apple_id_auth" -eq 1 ]]; then
  printf '%s' "$APPLE_ID" | gh secret set APPLE_ID -R "$repo" >/dev/null
  printf '%s' "$APPLE_PASSWORD" | gh secret set APPLE_PASSWORD -R "$repo" >/dev/null
  printf '%s' "$team_id" | gh secret set APPLE_TEAM_ID -R "$repo" >/dev/null
fi

if [[ "$has_api_key_auth" -eq 1 ]]; then
  printf '%s' "$APPLE_API_KEY" | gh secret set APPLE_API_KEY -R "$repo" >/dev/null
  printf '%s' "$APPLE_API_ISSUER" | gh secret set APPLE_API_ISSUER -R "$repo" >/dev/null
  gh secret set APPLE_API_KEY_P8 -R "$repo" < "$APPLE_API_KEY_P8_PATH" >/dev/null
fi

echo "Done. Verify with: gh secret list -R $repo"
