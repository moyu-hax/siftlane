# Siftlane

Siftlane is a lightweight Web control panel for grouped proxy nodes. It keeps the feature surface small:

- Web password login
- JSON data storage
- Custom node groups
- Timed health checks
- Failed nodes are auto-disabled
- Recovered nodes are auto-enabled
- sing-box runtime config generation
- Linux x64 / arm64 builds through GitHub Actions

## Run Locally

Install `sing-box` first, then start Siftlane:

```bash
npm install
npm start
```

Open `http://127.0.0.1:51888` and set the first Web password.

Environment variables:

- `SIFTLANE_HOST`: Web listen host, default `0.0.0.0`
- `SIFTLANE_PORT`: Web listen port, default `51888`
- `SIFTLANE_DATA_DIR`: JSON data directory, default `./data`
- `SING_BOX_PATH`: sing-box executable path, default `sing-box`

## Build

```bash
npm install
npm run build:linux
```

GitHub Actions will produce:

- `siftlane-linux-x64`
- `siftlane-linux-arm64`

## Server Install

On the server, keep the installer, downloads, extracted artifact, binary, and data under `/root/siftlane`:

```bash
mkdir -p /root/siftlane
cd /root/siftlane
curl -fsSL -o install-server.sh https://raw.githubusercontent.com/moyu-hax/siftlane/main/scripts/install-server.sh
sudo LEME_DOWNLOAD_URL="https://github.com/moyu-hax/siftlane/actions/runs/RUN_ID/artifacts/ARTIFACT_ID" bash install-server.sh
```

The installer uses a local binary first when `/root/siftlane/siftlane-linux-x64` or `/root/siftlane/siftlane-linux-arm64` exists. If no local binary exists, it downloads the artifact URL, unzips it, selects the correct binary for the server architecture, installs sing-box if needed, and starts the `siftlane` systemd service.

The service name is `siftlane`.
