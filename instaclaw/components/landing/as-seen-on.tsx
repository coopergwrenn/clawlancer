/**
 * AsSeenOn — social proof component showing platforms where InstaClaw is listed.
 *
 * Update the `listings` array as InstaClaw gets listed on new platforms.
 * Set `live: true` and add the URL when the listing goes live.
 */

const listings: { name: string; url?: string; live: boolean }[] = [
  { name: "Product Hunt", live: false },
  { name: "G2", live: false },
  { name: "Capterra", live: false },
  { name: "Crunchbase", live: false },
  { name: "AlternativeTo", live: false },
];

const liveListings = listings.filter((l) => l.live);

export function AsSeenOn() {
  // Don't render anything until at least one listing is live
  if (liveListings.length === 0) return null;

  return (
    <section className="py-10 sm:py-14 px-4">
      <div className="max-w-3xl mx-auto text-center">
        <p
          className="text-xs font-medium uppercase tracking-[0.15em] mb-6"
          style={{ color: "#999" }}
        >
          As seen on
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
          {liveListings.map((listing) =>
            listing.url ? (
              <a
                key={listing.name}
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium transition-opacity hover:opacity-70"
                style={{ color: "#6b6b6b" }}
              >
                {listing.name}
              </a>
            ) : (
              <span
                key={listing.name}
                className="text-sm font-medium"
                style={{ color: "#6b6b6b" }}
              >
                {listing.name}
              </span>
            )
          )}
        </div>
      </div>
    </section>
  );
}
