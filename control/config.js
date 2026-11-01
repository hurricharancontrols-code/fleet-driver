/*
 * Control room page settings.
 * apiUrl: the SAME Web app URL as the driver app (Apps Script > Deploy > Manage deployments).
 *         Leave it empty ('') to run in DEMO mode with made-up sample loads: any username, PIN 123456.
 */
window.CONTROL_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbywdUb9vlbM76XEwopfUQHay8XAkPwVqsVwU6jnc5xF08kZKgxg51wpEfapeFuftaeB/exec',

  // How often the page fetches new loads, in seconds.
  refreshSeconds: 60,

  // A truck that was loaded but has no offloading after this many hours is shown as "Overdue".
  overdueHours: 48,

  // Photos below this sharpness are listed under "Needs attention" (the phone app rejects below 120).
  lowSharpness: 120,

  // A driver with no upload for this many hours is marked "Quiet" (only if they used the app in the period).
  quietHours: 24,

  // Monthly work-data allowance per driver in MB. 0 = no warning.
  dataAllowanceMb: 0,

  // Day of the month the load period starts (25 = 25th to 24th of the next month).
  periodStartDay: 25
};
