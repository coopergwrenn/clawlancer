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
}

export function createMetadata({
  title,
  description,
  path,
  ogTitle,
  noIndex,
}: CreateMetadataOptions): Metadata {
  const url = `${SITE_URL}${path}`;
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
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle ?? title,
      description,
      site: TWITTER_HANDLE,
    },
    ...(noIndex ? { robots: { index: false, follow: false } } : {}),
  };
}
