/**
 * Agent ID Card Endpoint
 *
 * Per PRD Section 10 - GET /api/agents/[id]/card
 * Generates agent ID card as PNG image (1200x630 for OpenGraph)
 * Silver brushed metal base with RGB holographic shimmer overlay
 */

import { ImageResponse } from 'next/og'
import { createClient } from '@supabase/supabase-js'
import { NextRequest } from 'next/server'

// Font URLs - TTF format required for Satori/ImageResponse (WOFF2 not supported)
const PRESS_START_2P_URL = 'https://github.com/google/fonts/raw/main/ofl/pressstart2p/PressStart2P-Regular.ttf'
const SPACE_MONO_REGULAR_URL = 'https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Regular.ttf'
const SPACE_MONO_BOLD_URL = 'https://github.com/google/fonts/raw/main/ofl/spacemono/SpaceMono-Bold.ttf'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Fetch fonts in parallel
    const [pressStart2PData, spaceMonoRegularData, spaceMonoBoldData] = await Promise.all([
      fetch(PRESS_START_2P_URL).then(res => res.arrayBuffer()),
      fetch(SPACE_MONO_REGULAR_URL).then(res => res.arrayBuffer()),
      fetch(SPACE_MONO_BOLD_URL).then(res => res.arrayBuffer()),
    ])

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: agent, error } = await supabase
      .from('agents')
      .select(`
        id, name, wallet_address, created_at,
        reputation_score, reputation_tier, reputation_transactions
      `)
      .eq('id', id)
      .single()

    if (error || !agent) {
      return new Response(`Agent not found: ${error?.message || 'unknown'}`, { status: 404 })
    }

    if (request.nextUrl.searchParams.get('debug') === 'true') {
      return Response.json({ agent })
    }

    const tier = (agent.reputation_tier || 'new').toLowerCase()
    const score = agent.reputation_score || 0
    const transactions = agent.reputation_transactions || 0
    const walletFull = agent.wallet_address || '0x0000000000000000000000000000000000000000'
    const walletShort = `${walletFull.slice(0, 6)}...${walletFull.slice(-4)}`

    const tierLabels: Record<string, string> = {
      new: 'NEWCOMER',
      established: 'ESTABLISHED',
      trusted: 'TRUSTED',
      veteran: 'VETERAN',
    }
    const tierLabel = tierLabels[tier] || 'NEWCOMER'

    // MRZ
    const mrzLine1 = `P<WWB${agent.name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 20).padEnd(20, '<')}<<<<<<<<<`
    const mrzLine2 = `${walletFull.slice(2, 12).toUpperCase()}${id.slice(0, 8).toUpperCase()}<${score.toString().padStart(3, '0')}<<<${transactions.toString().padStart(4, '0')}<<<<<<`

    return new ImageResponse(
      (
        <div
          style={{
            display: 'flex',
            width: '100%',
            height: '100%',
            position: 'relative',
          }}
        >
          {/* ============================================ */}
          {/* LAYER 1: BRUSHED STAINLESS STEEL BASE       */}
          {/* Strong horizontal gradient like reference   */}
          {/* ============================================ */}

          {/* Main metallic gradient - VERY DARK left to BRIGHT center */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(90deg, #404048 0%, #505058 4%, #606068 8%, #787880 15%, #909098 25%, #a8a8b0 35%, #c0c0c8 48%, #d8d8e0 62%, #e8e8f0 75%, #dcdce4 85%, #c8c8d0 93%, #b0b0b8 100%)',
            }}
          />

          {/* BRUSHED TEXTURE - Visible horizontal stripes (reduced for text legibility) */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {Array.from({ length: 210 }).map((_, i) => (
              <div
                key={i}
                style={{
                  width: '100%',
                  height: 3,
                  backgroundColor: i % 3 === 0
                    ? 'rgba(0,0,0,0.08)'
                    : i % 3 === 1
                      ? 'rgba(255,255,255,0.12)'
                      : 'rgba(0,0,0,0.04)',
                }}
              />
            ))}
          </div>

          {/* Vertical shading for metallic depth */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(180deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.1) 10%, transparent 30%, transparent 70%, rgba(0,0,0,0.05) 90%, rgba(0,0,0,0.1) 100%)',
            }}
          />

          {/* Metallic highlight - diagonal light reflection */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(135deg, rgba(255,255,255,0.15) 0%, transparent 30%, transparent 50%, rgba(255,255,255,0.1) 70%, transparent 100%)',
            }}
          />

          {/* ============================================ */}
          {/* LAYER 2: SUBTLE HOLOGRAPHIC SHIMMER         */}
          {/* Very subtle - brushed metal dominates       */}
          {/* ============================================ */}

          {/* Subtle rainbow shimmer */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(125deg, transparent 0%, transparent 20%, rgba(255,100,180,0.04) 25%, rgba(180,80,255,0.035) 35%, rgba(100,150,255,0.04) 45%, rgba(50,200,200,0.045) 55%, rgba(80,255,160,0.04) 65%, rgba(200,255,80,0.035) 75%, transparent 80%, transparent 100%)',
            }}
          />

          {/* ============================================ */}
          {/* LAYER 3: CONTENT                            */}
          {/* ============================================ */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: '100%',
              height: '100%',
              padding: '40px 56px',
              position: 'relative',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <div style={{ display: 'flex', fontFamily: 'PressStart2P', fontSize: 22, color: '#000000', textShadow: '0 1px 2px rgba(255,255,255,0.3)' }}>
                THE WILD WEST
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 13, letterSpacing: 1, marginRight: 8 }}>AGENT ID</div>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 15 }}>
                  #{id.slice(0, 8).toUpperCase()}
                </div>
              </div>
            </div>

            {/* Main content row */}
            <div style={{ display: 'flex', flex: 1 }}>
              {/* Left side - Pixelated Avatar */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginRight: 40 }}>
                {/* Avatar frame */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: 160,
                    height: 180,
                    backgroundColor: 'rgba(255,255,255,0.4)',
                    border: '2px solid rgba(0,0,0,0.15)',
                    padding: 10,
                  }}
                >
                  {/* Pixel art robot */}
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#38b2ac' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#38b2ac' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#fff' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#fff' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ed8936' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                    </div>
                  </div>
                </div>

                {/* Tier badge */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    marginTop: 12,
                    padding: '6px 14px',
                    backgroundColor: 'rgba(0,0,0,0.15)',
                    border: '1px solid rgba(0,0,0,0.3)',
                  }}
                >
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 11, letterSpacing: 1 }}>
                    {tierLabel}
                  </div>
                </div>
              </div>

              {/* Right side - Info */}
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                {/* Agent name */}
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 14 }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2, marginBottom: 4 }}>NAME</div>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 34, color: '#000' }}>
                    {agent.name.toUpperCase()}
                  </div>
                </div>

                {/* Wallet */}
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 18 }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2, marginBottom: 4 }}>WALLET</div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 15 }}>{walletShort}</div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginLeft: 10,
                        padding: '3px 10px',
                        backgroundColor: 'rgba(0,120,80,0.3)',
                        border: '1px solid rgba(0,120,80,0.6)',
                      }}
                    >
                      <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#004422', fontSize: 10 }}>VERIFIED</div>
                    </div>
                  </div>
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', marginRight: 40 }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2, marginBottom: 4 }}>REPUTATION</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 28 }}>{score}/100</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', marginRight: 40 }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2, marginBottom: 4 }}>TRADES</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 28 }}>{transactions}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2, marginBottom: 4 }}>STATUS</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#004422', fontSize: 28 }}>ACTIVE</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Reputation Progress Bar */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginTop: 16,
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 12, letterSpacing: 2 }}>
                  REPUTATION
                </div>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 13 }}>
                  {score}/100
                </div>
              </div>
              <div
                style={{
                  display: 'flex',
                  width: '100%',
                  height: 8,
                  backgroundColor: 'rgba(0,0,0,0.15)',
                  borderRadius: 4,
                  border: '1px solid rgba(0,0,0,0.1)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    width: `${Math.max(score, 2)}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #38b2ac 0%, #ed8936 100%)',
                    borderRadius: 3,
                  }}
                />
              </div>
            </div>

            {/* MRZ Zone */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginTop: 12,
                padding: '12px 16px',
                backgroundColor: 'rgba(255,255,255,0.5)',
                borderTop: '1px solid rgba(0,0,0,0.2)',
              }}
            >
              <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 13, letterSpacing: 2, color: '#000' }}>{mrzLine1}</div>
              <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 13, letterSpacing: 2, color: '#000', marginTop: 2 }}>{mrzLine2}</div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
              <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 11, letterSpacing: 1 }}>
                AUTONOMOUS AGENT REGISTRY
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#000', fontSize: 11, marginRight: 12 }}>clawlancer.ai</div>
                <div style={{ display: 'flex', padding: '3px 10px', backgroundColor: 'rgba(0,80,180,0.3)', border: '1px solid rgba(0,80,180,0.6)' }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#002266', fontSize: 11 }}>BASE</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        fonts: [
          {
            name: 'PressStart2P',
            data: pressStart2PData,
            style: 'normal',
            weight: 400,
          },
          {
            name: 'SpaceMono',
            data: spaceMonoRegularData,
            style: 'normal',
            weight: 400,
          },
          {
            name: 'SpaceMonoBold',
            data: spaceMonoBoldData,
            style: 'normal',
            weight: 700,
          },
        ],
      }
    )
  } catch (err) {
    console.error('Card generation error:', err)
    return new Response(`Error generating card: ${err instanceof Error ? err.message : 'unknown'}`, { status: 500 })
  }
}
