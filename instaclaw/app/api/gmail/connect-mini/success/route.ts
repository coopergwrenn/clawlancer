import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/gmail/connect-mini/success
 *
 * Shows a success page after mini app users complete Gmail OAuth.
 * Tells them to return to World App.
 */
export async function GET() {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Google Connected - InstaClaw</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8f7f4;
      color: #333334;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      text-align: center;
      max-width: 340px;
    }
    .check {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: linear-gradient(135deg, rgba(34,197,94,0.15), rgba(34,197,94,0.25));
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
      animation: pop 0.4s ease-out;
    }
    .check svg { width: 32px; height: 32px; color: #16a34a; }
    h1 {
      font-family: 'Instrument Serif', Georgia, serif;
      font-size: 1.5rem;
      font-weight: 400;
      margin-bottom: 0.75rem;
      letter-spacing: -0.5px;
    }
    p {
      color: #6b6b6b;
      font-size: 0.875rem;
      line-height: 1.6;
      margin-bottom: 1.5rem;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(170deg, #c97856, #b45e3a);
      color: #fff;
      text-decoration: none;
      padding: 0.75rem 2rem;
      border-radius: 0.75rem;
      font-weight: 600;
      font-size: 0.9rem;
      margin-bottom: 1rem;
      box-shadow: 0 4px 16px rgba(200,105,60,0.35);
    }
    .hint {
      font-size: 0.75rem;
      color: #aaa;
    }
    @keyframes pop {
      0% { transform: scale(0.5); opacity: 0; }
      100% { transform: scale(1); opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
      </svg>
    </div>
    <h1>Google connected</h1>
    <p>Your agent will now personalize itself based on your inbox patterns.</p>
    <a href="https://world.org/mini-app?app_id=app_a4e2de774b1bda0426e78cda2ddb8cfd" class="btn">Return to World App</a>
    <p class="hint">Or close this tab and switch back manually.</p>
    <script>
      // Auto-redirect back to World App after 2 seconds
      setTimeout(function() {
        window.location.href = "https://world.org/mini-app?app_id=app_a4e2de774b1bda0426e78cda2ddb8cfd";
      }, 2000);
    </script>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}
