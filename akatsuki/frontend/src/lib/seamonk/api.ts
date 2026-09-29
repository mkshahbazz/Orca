/**
 * THE SEAMONK — backend base URL, in one place.
 *
 * Every client module (DataProvider, MonkChat, community contributions and the
 * landing widget) resolves the marine-intelligence API through this constant
 * instead of repeating the environment lookup, so a deployment can only ever
 * point at one backend.
 *
 * The frontend is a static export, so this value is baked in at build time from
 * the repository variable `NEXT_PUBLIC_API_URL` (see .github/workflows).
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
