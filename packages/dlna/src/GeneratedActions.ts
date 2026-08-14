// Generated from the vendored UPnP service descriptions. Do not edit.
//
// Source: packages/dlna/vendor/AVTransport1.scpd.xml
// Source: packages/dlna/vendor/RenderingControl1.scpd.xml
//
// A SOAP request carries its arguments positionally, so an action built with
// them in the wrong order is a well-formed request that a television accepts
// and ignores. These builders take a named record and put them in the order
// the service declared, which is why they are generated rather than written.
//
//   npm run codegen   regenerate from packages/dlna/vendor

import type { Action } from "./Soap.ts"

// --- AVTransport -------------------------------------------------------

/** Loading media and controlling playback. */
export const AVTransport = "urn:schemas-upnp-org:service:AVTransport:1"

/** `SetAVTransportURI`. */
export const setAVTransportURI = (args: {
  readonly InstanceID: string
  readonly CurrentURI: string
  readonly CurrentURIMetaData: string
}): Action => ({
  service: AVTransport,
  name: "SetAVTransportURI",
  args: [
    ["InstanceID", args.InstanceID],
    ["CurrentURI", args.CurrentURI],
    ["CurrentURIMetaData", args.CurrentURIMetaData]
  ]
})

/** Output argument names of `SetAVTransportURI`, in declared order. */
export const setAVTransportURIOutputs = [] as const

/** `SetNextAVTransportURI`. */
export const setNextAVTransportURI = (args: {
  readonly InstanceID: string
  readonly NextURI: string
  readonly NextURIMetaData: string
}): Action => ({
  service: AVTransport,
  name: "SetNextAVTransportURI",
  args: [
    ["InstanceID", args.InstanceID],
    ["NextURI", args.NextURI],
    ["NextURIMetaData", args.NextURIMetaData]
  ]
})

/** Output argument names of `SetNextAVTransportURI`, in declared order. */
export const setNextAVTransportURIOutputs = [] as const

/**
 * `GetMediaInfo`, answering:
 * NrTracks
 * MediaDuration
 * CurrentURI
 * CurrentURIMetaData
 * NextURI
 * NextURIMetaData
 * PlayMedium
 * RecordMedium
 * WriteStatus
 */
export const getMediaInfo = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetMediaInfo",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetMediaInfo`, in declared order. */
export const getMediaInfoOutputs = [
  "NrTracks",
  "MediaDuration",
  "CurrentURI",
  "CurrentURIMetaData",
  "NextURI",
  "NextURIMetaData",
  "PlayMedium",
  "RecordMedium",
  "WriteStatus"
] as const

/** `GetTransportInfo`, answering CurrentTransportState, CurrentTransportStatus, CurrentSpeed. */
export const getTransportInfo = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetTransportInfo",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetTransportInfo`, in declared order. */
export const getTransportInfoOutputs = [
  "CurrentTransportState",
  "CurrentTransportStatus",
  "CurrentSpeed"
] as const

/**
 * `GetPositionInfo`, answering:
 * Track
 * TrackDuration
 * TrackMetaData
 * TrackURI
 * RelTime
 * AbsTime
 * RelCount
 * AbsCount
 */
export const getPositionInfo = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetPositionInfo",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetPositionInfo`, in declared order. */
export const getPositionInfoOutputs = [
  "Track",
  "TrackDuration",
  "TrackMetaData",
  "TrackURI",
  "RelTime",
  "AbsTime",
  "RelCount",
  "AbsCount"
] as const

/** `GetDeviceCapabilities`, answering PlayMedia, RecMedia, RecQualityModes. */
export const getDeviceCapabilities = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetDeviceCapabilities",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetDeviceCapabilities`, in declared order. */
export const getDeviceCapabilitiesOutputs = ["PlayMedia", "RecMedia", "RecQualityModes"] as const

/** `GetTransportSettings`, answering PlayMode, RecQualityMode. */
export const getTransportSettings = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetTransportSettings",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetTransportSettings`, in declared order. */
export const getTransportSettingsOutputs = ["PlayMode", "RecQualityMode"] as const

/** `Stop`. */
export const stop = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "Stop",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `Stop`, in declared order. */
export const stopOutputs = [] as const

/** `Play`. */
export const play = (args: { readonly InstanceID: string; readonly Speed: string }): Action => ({
  service: AVTransport,
  name: "Play",
  args: [
    ["InstanceID", args.InstanceID],
    ["Speed", args.Speed]
  ]
})

/** Output argument names of `Play`, in declared order. */
export const playOutputs = [] as const

/** `Pause`. */
export const pause = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "Pause",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `Pause`, in declared order. */
export const pauseOutputs = [] as const

/** `Seek`. */
export const seek = (args: {
  readonly InstanceID: string
  readonly Unit: string
  readonly Target: string
}): Action => ({
  service: AVTransport,
  name: "Seek",
  args: [
    ["InstanceID", args.InstanceID],
    ["Unit", args.Unit],
    ["Target", args.Target]
  ]
})

/** Output argument names of `Seek`, in declared order. */
export const seekOutputs = [] as const

/** `Next`. */
export const next = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "Next",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `Next`, in declared order. */
export const nextOutputs = [] as const

/** `Previous`. */
export const previous = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "Previous",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `Previous`, in declared order. */
export const previousOutputs = [] as const

/** `SetPlayMode`. */
export const setPlayMode = (args: {
  readonly InstanceID: string
  readonly NewPlayMode: string
}): Action => ({
  service: AVTransport,
  name: "SetPlayMode",
  args: [
    ["InstanceID", args.InstanceID],
    ["NewPlayMode", args.NewPlayMode]
  ]
})

/** Output argument names of `SetPlayMode`, in declared order. */
export const setPlayModeOutputs = [] as const

/** `GetCurrentTransportActions`, answering Actions. */
export const getCurrentTransportActions = (args: { readonly InstanceID: string }): Action => ({
  service: AVTransport,
  name: "GetCurrentTransportActions",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `GetCurrentTransportActions`, in declared order. */
export const getCurrentTransportActionsOutputs = ["Actions"] as const

// --- RenderingControl --------------------------------------------------

/** Volume and mute. */
export const RenderingControl = "urn:schemas-upnp-org:service:RenderingControl:1"

/** `ListPresets`, answering CurrentPresetNameList. */
export const listPresets = (args: { readonly InstanceID: string }): Action => ({
  service: RenderingControl,
  name: "ListPresets",
  args: [
    ["InstanceID", args.InstanceID]
  ]
})

/** Output argument names of `ListPresets`, in declared order. */
export const listPresetsOutputs = ["CurrentPresetNameList"] as const

/** `SelectPreset`. */
export const selectPreset = (args: {
  readonly InstanceID: string
  readonly PresetName: string
}): Action => ({
  service: RenderingControl,
  name: "SelectPreset",
  args: [
    ["InstanceID", args.InstanceID],
    ["PresetName", args.PresetName]
  ]
})

/** Output argument names of `SelectPreset`, in declared order. */
export const selectPresetOutputs = [] as const

/** `GetMute`, answering CurrentMute. */
export const getMute = (args: {
  readonly InstanceID: string
  readonly Channel: string
}): Action => ({
  service: RenderingControl,
  name: "GetMute",
  args: [
    ["InstanceID", args.InstanceID],
    ["Channel", args.Channel]
  ]
})

/** Output argument names of `GetMute`, in declared order. */
export const getMuteOutputs = ["CurrentMute"] as const

/** `SetMute`. */
export const setMute = (args: {
  readonly InstanceID: string
  readonly Channel: string
  readonly DesiredMute: string
}): Action => ({
  service: RenderingControl,
  name: "SetMute",
  args: [
    ["InstanceID", args.InstanceID],
    ["Channel", args.Channel],
    ["DesiredMute", args.DesiredMute]
  ]
})

/** Output argument names of `SetMute`, in declared order. */
export const setMuteOutputs = [] as const

/** `GetVolume`, answering CurrentVolume. */
export const getVolume = (args: {
  readonly InstanceID: string
  readonly Channel: string
}): Action => ({
  service: RenderingControl,
  name: "GetVolume",
  args: [
    ["InstanceID", args.InstanceID],
    ["Channel", args.Channel]
  ]
})

/** Output argument names of `GetVolume`, in declared order. */
export const getVolumeOutputs = ["CurrentVolume"] as const

/** `SetVolume`. */
export const setVolume = (args: {
  readonly InstanceID: string
  readonly Channel: string
  readonly DesiredVolume: string
}): Action => ({
  service: RenderingControl,
  name: "SetVolume",
  args: [
    ["InstanceID", args.InstanceID],
    ["Channel", args.Channel],
    ["DesiredVolume", args.DesiredVolume]
  ]
})

/** Output argument names of `SetVolume`, in declared order. */
export const setVolumeOutputs = [] as const
