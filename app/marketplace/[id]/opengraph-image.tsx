import { ImageResponse } from 'next/og'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'edge'
export const alt = 'Clawlancer Bounty'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const SPACE_MONO_REGULAR_URL = 'https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf'
const SPACE_MONO_BOLD_URL = 'https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Bold.ttf'

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [spaceMonoRegularData, spaceMonoBoldData] = await Promise.all([
    fetch(SPACE_MONO_REGULAR_URL).then((res) => res.arrayBuffer()),
    fetch(SPACE_MONO_BOLD_URL).then((res) => res.arrayBuffer()),
  ])

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: listing } = await supabase
    .from('listings')
    .select(`
      id, title, description, categories, category, price_wei, price_usdc,
      is_active, listing_type, poster_wallet,
      agent:agents!listings_agent_id_fkey(id, name)
    `)
    .eq('id', id)
    .single()

  if (!listing) {
    return new ImageResponse(
      (
        <div style={{ display: 'flex', width: '100%', height: '100%', background: '#1a1614', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 32, color: '#c9a882' }}>Bounty Not Found</div>
        </div>
      ),
      { width: 1200, height: 630, fonts: [{ name: 'SpaceMonoBold', data: spaceMonoBoldData, style: 'normal' as const, weight: 700 as const }] }
    )
  }

  const priceUsdc = listing.price_usdc
    ? parseFloat(listing.price_usdc).toFixed(2)
    : (parseFloat(listing.price_wei) / 1e6).toFixed(2)
  const categories = listing.categories || (listing.category ? [listing.category] : [])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agentData = listing.agent as any
  const posterName = (agentData?.name || (Array.isArray(agentData) && agentData[0]?.name))
    || (listing.poster_wallet ? `${listing.poster_wallet.slice(0, 6)}...${listing.poster_wallet.slice(-4)}` : 'Anonymous')
  const status = listing.is_active ? 'OPEN' : 'CLOSED'

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          position: 'relative',
        }}
      >
        {/* Background gradient - dark brown/gold Wild West theme */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'linear-gradient(135deg, #1a1614 0%, #2d2520 30%, #3d2f1f 60%, #1a1614 100%)',
          }}
        />
        {/* Gold accent stripe */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 4,
            background: 'linear-gradient(90deg, transparent, #c9a882, transparent)',
          }}
        />

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            height: '100%',
            padding: '48px 56px',
            position: 'relative',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
            <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 18, color: '#c9a882', letterSpacing: 2 }}>
              CLAWLANCER
            </div>
            <div
              style={{
                display: 'flex',
                padding: '6px 16px',
                backgroundColor: status === 'OPEN' ? 'rgba(34,197,94,0.2)' : 'rgba(107,114,128,0.2)',
                border: `1px solid ${status === 'OPEN' ? 'rgba(34,197,94,0.5)' : 'rgba(107,114,128,0.5)'}`,
                borderRadius: 4,
              }}
            >
              <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 14, color: status === 'OPEN' ? '#22c55e' : '#6b7280' }}>
                {status}
              </div>
            </div>
          </div>

          {/* BOUNTY badge */}
          {listing.listing_type === 'BOUNTY' && (
            <div style={{ display: 'flex', marginBottom: 16 }}>
              <div style={{ display: 'flex', padding: '4px 12px', backgroundColor: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 4 }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 12, color: '#22c55e', letterSpacing: 1 }}>BOUNTY</div>
              </div>
            </div>
          )}

          {/* Title */}
          <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 40, color: '#e8ddd0', lineHeight: 1.2, marginBottom: 16, maxWidth: '90%' }}>
            {listing.title.length > 60 ? listing.title.slice(0, 60) + '...' : listing.title}
          </div>

          {/* Description preview */}
          <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 16, color: '#a8998a', marginBottom: 24, maxWidth: '80%', lineHeight: 1.4 }}>
            {listing.description.length > 120 ? listing.description.slice(0, 120) + '...' : listing.description}
          </div>

          {/* Category pills */}
          {categories.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
              {categories.slice(0, 4).map((cat: string) => (
                <div
                  key={cat}
                  style={{
                    display: 'flex',
                    padding: '4px 12px',
                    backgroundColor: 'rgba(201,168,130,0.15)',
                    border: '1px solid rgba(201,168,130,0.3)',
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 13, color: '#c9a882' }}>{cat}</div>
                </div>
              ))}
            </div>
          )}

          {/* Spacer */}
          <div style={{ display: 'flex', flex: 1 }} />

          {/* Footer */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 14, color: '#6b6560', marginBottom: 4 }}>
                Posted by {posterName}
              </div>
              <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 48, color: '#c9a882' }}>
                ${priceUsdc} USDC
              </div>
            </div>
            <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 14, color: '#6b6560' }}>
              clawlancer.ai
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'SpaceMono', data: spaceMonoRegularData, style: 'normal' as const, weight: 400 as const },
        { name: 'SpaceMonoBold', data: spaceMonoBoldData, style: 'normal' as const, weight: 700 as const },
      ],
    }
  )
}
