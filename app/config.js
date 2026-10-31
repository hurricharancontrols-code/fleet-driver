/*
 * Fleet Driver App settings.
 * apiUrl: paste the Web app URL from Apps Script (Deploy > Manage deployments).
 *         Leave it empty ('') to run in DEMO mode: nothing is sent, any username works with PIN 123456.
 */
window.FLEET_CONFIG = {
  apiUrl: '',

  // Photo size kept for sending (longest side, pixels) and JPEG quality.
  maxPixels: 2048,
  jpegQuality: 0.82,

  // Photo checks. Sharpness is measured on the sent photo; raise minSharpness to be stricter.
  // These starting values will be tuned on real driver photos during the pilot.
  checks: {
    doc: { minSharpness: 120, minBrightness: 70, maxBrightness: 245, maxGlare: 0.25 },
    odo: { minSharpness: 60,  minBrightness: 25, maxBrightness: 250, maxGlare: 0.40 }
  },

  // After this many failed checks on one photo, the driver may send it anyway (flagged for the controller).
  allowFlagAfter: 2,

  // Days to keep sent photos on the phone (for sharing to WhatsApp), to save phone storage.
  keepPhotosDays: 7,

  // Monthly work-data allowance in MB, used for the warning on the home screen. 0 = no warning.
  dataAllowanceMb: 0
};
https://script.google.com/macros/s/AKfycbx1g2LgLUhSOmuZ6mUzmDAO1gAwwyBIrQZXq0tZPEKr5hivS4JV5XRJSnpT5hsO0HLm/exec