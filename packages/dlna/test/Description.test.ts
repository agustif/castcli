// Device descriptions.
//
// The descriptions here are the shapes real hardware serves, not minimal ones:
// the vendor extensions, the deprecated `URLBase`, the embedded device lists
// and the relative control URLs are all things that turn up on an ordinary
// home network, and each of them has its own way of quietly producing a device
// that appears in the list and then never responds.

import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { parseRenderer } from "../src/Description.ts"

/** Where a Samsung set actually serves its description. */
const SAMSUNG_LOCATION = "http://192.168.1.42:9197/dmr"

const SAMSUNG = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0"
      xmlns:sec="http://www.sec.co.kr/dlna">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>[TV] Samsung Q80A</friendlyName>
    <manufacturer>Samsung Electronics</manufacturer>
    <manufacturerURL>http://www.samsung.com/sec</manufacturerURL>
    <modelDescription>Samsung TV DMR</modelDescription>
    <modelName>UN55Q80A</modelName>
    <modelNumber>AllShare1.0</modelNumber>
    <serialNumber>0000</serialNumber>
    <UDN>uuid:1b2c3d4e-5f60-1234-9abc-001a2b3c4d5e</UDN>
    <dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
    <sec:ProductCap>Y2020,WebURIPlayable,SeekPlayable,ScreenMirroringP2PMAC=00:1a:2b:3c:4d:5e</sec:ProductCap>
    <iconList>
      <icon>
        <mimetype>image/jpeg</mimetype><width>48</width><height>48</height>
        <depth>24</depth><url>/icon/icon_SML.jpg</url>
      </icon>
    </iconList>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
        <eventSubURL>/upnp/event/RenderingControl1</eventSubURL>
        <SCPDURL>/RenderingControl1.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <controlURL>/upnp/control/ConnectionManager1</controlURL>
        <eventSubURL>/upnp/event/ConnectionManager1</eventSubURL>
        <SCPDURL>/ConnectionManager1.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/upnp/control/AVTransport1</controlURL>
        <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
        <SCPDURL>/AVTransport1.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

/** A NAS: it answers discovery exactly as a television does, and cannot play. */
const CONTENT_DIRECTORY_ONLY = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>MyCloud</friendlyName>
    <manufacturer>Western Digital</manufacturer>
    <modelName>MyCloud EX2</modelName>
    <UDN>uuid:aaaabbbb-cccc-dddd-eeee-ffff00001111</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/ctl/ContentDir</controlURL>
        <eventSubURL>/evt/ContentDir</eventSubURL>
        <SCPDURL>/ContentDir.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <controlURL>/ctl/ConnectionMgr</controlURL>
        <eventSubURL>/evt/ConnectionMgr</eventSubURL>
        <SCPDURL>/ConnectionMgr.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

/** A combined box: the root device plays nothing, the embedded one does. */
const EMBEDDED = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>Living Room Hub</friendlyName>
    <manufacturer>Acme</manufacturer>
    <UDN>uuid:11111111-2222-3333-4444-555555555555</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>
        <controlURL>/ctl/ContentDir</controlURL>
        <eventSubURL>/evt/ContentDir</eventSubURL>
        <SCPDURL>/ContentDir.xml</SCPDURL>
      </service>
    </serviceList>
    <deviceList>
      <device>
        <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
        <friendlyName>Living Room Hub (Renderer)</friendlyName>
        <modelName>4200</modelName>
        <UDN>uuid:66666666-7777-8888-9999-000000000000</UDN>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
            <controlURL>AVTransport/control</controlURL>
            <eventSubURL>AVTransport/event</eventSubURL>
            <SCPDURL>AVTransport/scpd.xml</SCPDURL>
          </service>
        </serviceList>
      </device>
    </deviceList>
  </device>
</root>`

/** AVTransport:2, plus the UPnP 1.0 `URLBase` that moves the control server. */
const VERSION_TWO = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://10.0.0.5:2870/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:2</deviceType>
    <friendlyName>Sonos Beam</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <UDN>uuid:99999999-8888-7777-6666-555555555555</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>MediaRenderer/AVTransport/Control</controlURL>
        <eventSubURL>MediaRenderer/AVTransport/Event</eventSubURL>
        <SCPDURL>xml/AVTransport1.xml</SCPDURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:3</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>http://10.0.0.5:1400/MediaRenderer/RenderingControl/Control</controlURL>
        <eventSubURL>MediaRenderer/RenderingControl/Event</eventSubURL>
        <SCPDURL>xml/RenderingControl1.xml</SCPDURL>
      </service>
    </serviceList>
  </device>
</root>`

const renderer = (xml: string, location: string) =>
  Option.getOrThrow(parseRenderer(xml, location))

describe("a television's own description", () => {
  it("names the device as a person would see it", () => {
    assert.strictEqual(renderer(SAMSUNG, SAMSUNG_LOCATION).friendlyName, "[TV] Samsung Q80A")
  })

  it("resolves the AVTransport control URL against where it was fetched", () => {
    // `/upnp/control/AVTransport1` is not something anything can post to. Used
    // as it appears, the failure looks like the television ignoring us.
    assert.strictEqual(
      renderer(SAMSUNG, SAMSUNG_LOCATION).avTransport.controlUrl,
      "http://192.168.1.42:9197/upnp/control/AVTransport1"
    )
  })

  it("finds AVTransport behind the other services rather than taking the first", () => {
    assert.strictEqual(
      renderer(SAMSUNG, SAMSUNG_LOCATION).avTransport.serviceType,
      "urn:schemas-upnp-org:service:AVTransport:1"
    )
  })

  it("resolves RenderingControl too, which is where volume lives", () => {
    assert.deepStrictEqual(
      Option.map(renderer(SAMSUNG, SAMSUNG_LOCATION).renderingControl, (s) => s.controlUrl),
      Option.some("http://192.168.1.42:9197/upnp/control/RenderingControl1")
    )
  })

  it("reports the manufacturer and model when the device gives them", () => {
    const found = renderer(SAMSUNG, SAMSUNG_LOCATION)
    assert.deepStrictEqual(found.manufacturer, Option.some("Samsung Electronics"))
    assert.deepStrictEqual(found.modelName, Option.some("UN55Q80A"))
  })
})

describe("devices that are not renderers", () => {
  it("refuses a ContentDirectory-only device", () => {
    // A NAS answers discovery exactly as a television does. Offering it as a
    // playback target gives the user a device that will never respond.
    assert.deepStrictEqual(
      parseRenderer(CONTENT_DIRECTORY_ONLY, "http://192.168.1.9:9000/rootDesc.xml"),
      Option.none()
    )
  })

  it("refuses a document that is not a description at all", () => {
    // A LOCATION that 404s into an HTML error page is an ordinary event on a
    // network where a device has just rebooted.
    assert.deepStrictEqual(
      parseRenderer("<html><body>404 Not Found</body></html>", "http://192.168.1.9:9000/x"),
      Option.none()
    )
  })

  it("refuses truncated XML instead of failing", () => {
    // The parser throws on this; a half-served description must read as "not a
    // renderer", not as a crash in the middle of discovery.
    assert.deepStrictEqual(
      parseRenderer(SAMSUNG.slice(0, 400), SAMSUNG_LOCATION),
      Option.none()
    )
  })
})

describe("services nested in an embedded device", () => {
  const LOCATION = "http://192.168.1.77:8200/desc/device.xml"

  it("finds AVTransport inside the deviceList", () => {
    // A combined server-and-renderer box holds neither service at the root.
    // Looking only there finds nothing on exactly the hardware most likely to
    // be sitting on a home network.
    assert.strictEqual(
      renderer(EMBEDDED, LOCATION).avTransport.serviceType,
      "urn:schemas-upnp-org:service:AVTransport:1"
    )
  })

  it("resolves a path-relative control URL against the description's directory", () => {
    // `AVTransport/control` has no leading slash, so it hangs off `/desc/`
    // rather than off the root. Getting this wrong yields a 404, not an error.
    assert.strictEqual(
      renderer(EMBEDDED, LOCATION).avTransport.controlUrl,
      "http://192.168.1.77:8200/desc/AVTransport/control"
    )
  })

  it("takes the embedded device's own name when it has one", () => {
    assert.strictEqual(renderer(EMBEDDED, LOCATION).friendlyName, "Living Room Hub (Renderer)")
  })

  it("keeps a numeric-looking model name as text", () => {
    // Left to guess, the parser turns the model `4200` into a number, and a
    // model like `0080` into 80 — a name the device never said.
    assert.deepStrictEqual(renderer(EMBEDDED, LOCATION).modelName, Option.some("4200"))
  })

  it("has no RenderingControl, and says so rather than inventing one", () => {
    assert.deepStrictEqual(renderer(EMBEDDED, LOCATION).renderingControl, Option.none())
  })
})

describe("service versions", () => {
  const LOCATION = "http://10.0.0.5:1400/xml/device_description.xml"

  it("finds AVTransport:2, because the version is the device's choice", () => {
    // Later versions add actions rather than change the ones we send, so
    // matching the whole URN would skip a device we can drive perfectly well.
    assert.strictEqual(
      renderer(VERSION_TWO, LOCATION).avTransport.serviceType,
      "urn:schemas-upnp-org:service:AVTransport:2"
    )
  })

  it("finds RenderingControl:3 the same way", () => {
    assert.deepStrictEqual(
      Option.map(renderer(VERSION_TWO, LOCATION).renderingControl, (s) => s.serviceType),
      Option.some("urn:schemas-upnp-org:service:RenderingControl:3")
    )
  })

  it("prefers URLBase over the location, since it can move the port", () => {
    // UPnP 1.1 deprecated URLBase, but 1.0 devices are still shipping. One
    // that puts its control server on another port says so only here, and
    // ignoring it produces URLs that resolve to the wrong port and time out.
    assert.strictEqual(
      renderer(VERSION_TWO, LOCATION).avTransport.controlUrl,
      "http://10.0.0.5:2870/MediaRenderer/AVTransport/Control"
    )
  })

  it("leaves an already-absolute control URL alone", () => {
    assert.deepStrictEqual(
      Option.map(renderer(VERSION_TWO, LOCATION).renderingControl, (s) => s.controlUrl),
      Option.some("http://10.0.0.5:1400/MediaRenderer/RenderingControl/Control")
    )
  })
})
