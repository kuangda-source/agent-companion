"""Host playback and resource policy, independent of source artwork/manifests."""

MAX_VISIBLE_PETS = 3
VISIBLE_PIXEL_BUDGET = 8 * 1024 * 1024


def compiled_clip(agent, state, clips):
    clip = clips.get(state)
    idle = clips.get("idle", {})
    # Neutral ambient movement is presentation only: the player's expression and
    # observed Agent status remain UNKNOWN. Preserve any future authored clip.
    if (agent == "grok" and state == "unknown" and clip
            and len(clip["frames"]) == 1 and len(idle.get("frames", [])) > 1
            and idle.get("loop") and idle.get("motion", "none") == "none"):
        return {**idle, "frames": list(idle["frames"]), "motion": "none", "effect": "none"}
    return clip


def compiled_loop(agent, state, source_loop):
    # Grok's supplied v1 manifest must keep error.loop=true for its source schema.
    # The host requirement is a short response followed by a final-frame hold.
    return False if agent == "grok" and state == "error" else source_loop


def catalog_budget(pixel_sizes):
    sizes = sorted(pixel_sizes, reverse=True)
    visible = sum(sizes[:MAX_VISIBLE_PETS])
    if visible > VISIBLE_PIXEL_BUDGET:
        raise ValueError("visible pet pixel budget exceeds 8 MiB")
    return {
        "catalog_pixel_bytes": sum(sizes),
        "max_visible_pets": MAX_VISIBLE_PETS,
        "worst_visible_pixel_bytes": visible,
        "visible_pixel_budget_bytes": VISIBLE_PIXEL_BUDGET,
        "note": "Conservative full-frame pixel totals; not measured peak RAM. Catalog includes optional hidden providers.",
    }
