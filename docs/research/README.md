# Protocol Research Snapshot

This snapshot was captured on **2026-09-01** for research and reference purposes.

## Copyright Notice

All third-party documentation and specifications retain their original copyright:

- **Apple Inc.** — AirPlay, HomeKit Accessory Protocol (HAP), FairPlay Streaming, HLS, and related specifications
- **Google LLC** — Cast Application Framework (CAF), Chromecast, and related specifications
- **UPnP Forum** — Universal Plug and Play (UPnP) specifications
- **DLNA Alliance** — Digital Living Network Alliance guidelines (when available)
- **IETF** — Internet Engineering Task Force RFCs

## Purpose

This collection is provided for **research and reference only**. It documents the publicly available specifications and documentation for Cast, AirPlay, and DLNA protocols as of the snapshot date.

## Protocol Specification Availability

### None of the three protocols publish OpenAPI/Swagger specifications

- **Cast**: The official surface is the CAF JavaScript/iOS/Android SDK reference documentation, not a wire-level OpenAPI specification. The TLS/protobuf `CastMessage` framing is defined in Chromium's Open Screen project (`cast_channel.proto`). CAF `LOAD`/`QUEUE` commands are JSON payloads on that protobuf envelope.

- **AirPlay**: There is no public wire-level specification. Apple's Accessory Design Guidelines are HAP hardware guidelines, not the HAP control protocol. The HAP AirPlay wire specification is **MFi-only** (Made for iPhone/iPad/iPod program). Public references include: FairPlay Streaming Overview (FPS over AirPlay), Apple Platform Security (HAP crypto high-level), and HomeKit ADK headers citing HAP R14.

- **DLNA / UPnP**: Public specifications are available as PDFs from upnp.org, including UPnP Device Architecture (UDA), AV Architecture, MediaRenderer/MediaServer, and service specifications (AVTransport, RenderingControl, ConnectionManager, ContentDirectory). The **DLNA Alliance guidelines are members-only** and not publicly available.

## Contents

See [`protocol-specs/INDEX.md`](protocol-specs/INDEX.md) for a detailed inventory of downloaded specifications and [`protocol-specs/manifest.json`](protocol-specs/manifest.json) for the complete download manifest.

## Disclaimer

This snapshot is provided as-is for educational and research purposes. For production implementations, always consult the official vendor documentation, SDK references, and licensing requirements.
