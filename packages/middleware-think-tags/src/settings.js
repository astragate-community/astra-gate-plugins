// The settings and the migration of a v1 copy's options.

/** A stored value cleaned up into settings: anything but "to_content" is "strip". */
export const normalize = (raw) => ({ mode: raw && typeof raw === "object" && raw.mode === "to_content" ? "to_content" : "strip" })

/** The v1 options ({ mode }) are the settings as they are. */
export const fromV1Options = normalize
