import type { Metadata } from "next";

export const SITE_URL = "https://instaclaw.io";
export const SITE_NAME = "InstaClaw.io";
export const TWITTER_HANDLE = "@instaclaws";

interface CreateMetadataOptions {
  title: string;
  description: string;
  path: string;
  ogTitle?: string;
  noIndex?: boolean;
  /**
   * Path (or absolute URL) to a static OG share-card image. When set, wires
   * the image into BOTH openGraph.images AND twitter.images so previews on
   * Twitter / LinkedIn / Telegram / Slack render the branded card instead
   * of falling through to the platform's fallback (which typically grabs
   * the first random image in the page DOM at the wrong aspect ratio).
   *
   * Convention: pass a path relative to /public (e.g. "/edge/og-edge.png");
   * the function resolves it against SITE_URL. Absolute http(s) URLs are
   * accepted for off-domain images.
   *
   * Recommended dimensions: 1200×630 (1.91:1, Twitter/OG standard).
   */
  ogImage?: string;
}

export function createMetadata({
  title,
  description,
  path,
  ogTitle,
  noIndex,
  ogImage,
}: CreateMetadataOptions): Metadata {
  const url = `${SITE_URL}${path}`;
  const resolvedImage = ogImage
    ? ogImage.startsWith("http")
      ? ogImage
      : `${SITE_URL}${ogImage}`
    : undefined;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: ogTitle ?? title,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      ...(resolvedImage
        ? {
            images: [
              {
                url: resolvedImage,
                width: 1200,
                height: 630,
                alt: ogTitle ?? title,
              },
            ],
          }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle ?? title,
      description,
      site: TWITTER_HANDLE,
      ...(resolvedImage ? { images: [resolvedImage] } : {}),
    },
    ...(noIndex ? { robots: { index: false, follow: false } } : {}),
  };
}
