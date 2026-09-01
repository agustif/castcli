# Protocol specs pulled 2026-09-01

None of Cast, AirPlay, or DLNA publish OpenAPI/Swagger.

## Cast

Official surface is CAF JS/iOS/Android SDK reference, not a wire OpenAPI. TLS/protobuf CastMessage framing is Chromium Open Screen (cast_channel.proto). CAF LOAD/QUEUE is JSON on that envelope.

### Official Sources

- **Open Screen Protocol** (Chromium): Protobuf definitions for Cast channel framing, architecture, and protocol flow documentation
- **Google Cast Developers**: CAF media messages, queueing, core features, and framework reference (HTML documentation)
- **Sender SDKs**: Android and iOS sender documentation from developers.google.com/cast

### Community Reverse-Engineering

- **node-castv2** (thibauts): Community reverse-engineered Cast v2 protocol documentation

## AirPlay

No public wire spec. Public: Accessory Design Guidelines (hardware, not protocol), FairPlay Streaming Overview (FPS over AirPlay), Apple Platform Security (HAP crypto high-level), HomeKit ADK headers citing HAP R14. Control protocol is MFi-only.

### Public Apple Documentation

- **Accessory Design Guidelines**: Hardware design requirements for accessories (not protocol specification)
- **FairPlay Streaming**: Overview of FPS technology used with AirPlay
- **HLS Specifications**: HTTP Live Streaming draft specification and updates
- **Apple Platform Security Guide**: High-level security architecture including HAP crypto
- **HomeKit ADK**: Open source HomeKit Accessory Development Kit headers and documentation

### RFCs (mDNS, DNS-SD, HLS, Cryptography)

- RFC 6762: Multicast DNS (mDNS)
- RFC 6763: DNS-Based Service Discovery (DNS-SD)
- RFC 8216: HTTP Live Streaming (HLS)
- RFC 5054: SRP (Secure Remote Password)
- RFC 8439: ChaCha20-Poly1305 AEAD
- RFC 7748: Elliptic Curves (Curve25519, Curve448)
- RFC 8032: EdDSA (Ed25519)
- RFC 5869: HMAC-based Extract-and-Expand Key Derivation Function (HKDF)

## DLNA / UPnP

Public PDFs from upnp.org (UDA, AV Architecture, MediaRenderer/MediaServer, AVTransport, RenderingControl, ConnectionManager, ContentDirectory). DLNA Alliance guidelines are not public.

### UPnP Forum Specifications

- **UPnP Device Architecture v2.0**: Core UPnP protocol and device architecture
- **UPnP AV Architecture v2**: Audio/Video device architecture
- **MediaRenderer v3**: Media rendering device specification
- **MediaServer v4**: Media server device specification
- **AVTransport v3**: Audio/Video transport service
- **RenderingControl v3**: Rendering control service
- **ConnectionManager v3**: Connection management service
- **ContentDirectory v4**: Content directory service

### RFCs

- RFC 2616: HTTP/1.1 (used by UPnP/DLNA)

## Download Status

All files listed in `manifest.json` were downloaded. Any 404 errors or download failures are logged in `download-failures.txt` (if that file exists).
