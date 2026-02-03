/**
 * Agent ID Card Endpoint
 *
 * Per PRD Section 10 - GET /api/agents/[id]/card
 * Generates agent ID card as PNG image (1200x630 for OpenGraph)
 * Dark gunmetal metallic base with RGB holographic accents
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

    // RGB holographic gradients - brighter colors to pop against dark background
    const holoGradient1 = 'linear-gradient(125deg, transparent 0%, transparent 5%, rgba(255,50,150,0.25) 5%, rgba(255,50,150,0.25) 12%, rgba(255,0,100,0.2) 12%, rgba(255,0,100,0.2) 18%, rgba(150,50,255,0.2) 18%, rgba(150,50,255,0.2) 25%, rgba(50,150,255,0.25) 25%, rgba(50,150,255,0.25) 32%, rgba(0,255,200,0.3) 32%, rgba(0,255,200,0.3) 40%, rgba(50,255,100,0.3) 40%, rgba(50,255,100,0.3) 48%, rgba(150,255,50,0.25) 48%, rgba(150,255,50,0.25) 55%, rgba(255,255,50,0.2) 55%, rgba(255,255,50,0.2) 62%, rgba(255,150,50,0.2) 62%, rgba(255,150,50,0.2) 70%, rgba(255,100,80,0.2) 70%, rgba(255,100,80,0.2) 78%, rgba(255,50,120,0.2) 78%, rgba(255,50,120,0.2) 85%, transparent 85%, transparent 100%)'
    const holoGradient2 = 'linear-gradient(155deg, transparent 0%, transparent 15%, rgba(0,255,255,0.15) 15%, rgba(0,255,255,0.15) 25%, rgba(100,100,255,0.18) 25%, rgba(100,100,255,0.18) 35%, rgba(200,50,255,0.12) 35%, rgba(200,50,255,0.12) 45%, rgba(255,50,200,0.1) 45%, rgba(255,50,200,0.1) 55%, transparent 55%, transparent 100%)'

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
          {/* DARK GUNMETAL METALLIC BASE */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(145deg, #1a1a1f 0%, #252530 15%, #1e1e25 30%, #2a2a35 50%, #202028 70%, #28282f 85%, #1c1c22 100%)',
            }}
          />

          {/* Subtle brushed metal texture effect */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.04) 50%, rgba(255,255,255,0.02) 100%)',
            }}
          />

          {/* RGB HOLOGRAPHIC LAYER 1 - Main diagonal bands */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: holoGradient1,
            }}
          />

          {/* RGB HOLOGRAPHIC LAYER 2 - Secondary bands */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: holoGradient2,
            }}
          />

          {/* Subtle edge glow */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(90deg, rgba(0,255,200,0.08) 0%, transparent 5%, transparent 95%, rgba(255,0,150,0.08) 100%)',
            }}
          />

          {/* Vignette for depth */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.4) 100%)',
            }}
          />

          {/* Main content */}
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
              <div style={{ display: 'flex', fontFamily: 'PressStart2P', fontSize: 24, color: '#ffffff', textShadow: '0 0 20px rgba(0,255,200,0.5), 0 0 40px rgba(0,255,200,0.3)' }}>
                THE WILD WEST
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#888', fontSize: 11, letterSpacing: 1, marginRight: 8 }}>AGENT ID</div>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#fff', fontSize: 14 }}>
                  #{id.slice(0, 8).toUpperCase()}
                </div>
              </div>
            </div>

            {/* Main content row */}
            <div style={{ display: 'flex', flex: 1 }}>
              {/* Left side - Pixelated Avatar */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginRight: 40 }}>
                {/* Pixelated robot avatar frame */}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    width: 160,
                    height: 180,
                    backgroundColor: 'rgba(0,0,0,0.4)',
                    border: '2px solid rgba(255,255,255,0.2)',
                    padding: 10,
                    boxShadow: '0 0 20px rgba(0,255,200,0.1), inset 0 0 20px rgba(0,0,0,0.3)',
                  }}
                >
                  {/* Pixel art robot - row by row */}
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
                      <div style={{ width: 16, height: 16, backgroundColor: '#00ffcc' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#00ffcc' }} />
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
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <div style={{ display: 'flex' }}>
                      <div style={{ width: 16, height: 16, backgroundColor: '#4a5568' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
                      <div style={{ width: 16, height: 16, backgroundColor: '#ff6b9d' }} />
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
                    padding: '8px 16px',
                    backgroundColor: 'rgba(0,255,200,0.1)',
                    border: '1px solid rgba(0,255,200,0.3)',
                    boxShadow: '0 0 10px rgba(0,255,200,0.2)',
                  }}
                >
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#00ffcc', fontSize: 12, letterSpacing: 1 }}>
                    {tierLabel}
                  </div>
                </div>
              </div>

              {/* Right side - Info */}
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
                {/* Agent name */}
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 16 }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>NAME</div>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', fontSize: 36, color: '#ffffff', textShadow: '0 0 30px rgba(255,255,255,0.3)' }}>
                    {agent.name.toUpperCase()}
                  </div>
                </div>

                {/* Wallet */}
                <div style={{ display: 'flex', flexDirection: 'column', marginBottom: 20 }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>WALLET</div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#ccc', fontSize: 15 }}>{walletShort}</div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginLeft: 10,
                        padding: '3px 10px',
                        backgroundColor: 'rgba(0,255,150,0.15)',
                        border: '1px solid rgba(0,255,150,0.3)',
                      }}
                    >
                      <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#00ff99', fontSize: 9 }}>VERIFIED</div>
                    </div>
                  </div>
                </div>

                {/* Stats row */}
                <div style={{ display: 'flex' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', marginRight: 40 }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>REPUTATION</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#fff', fontSize: 28 }}>{score}/100</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', marginRight: 40 }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>TRADES</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#fff', fontSize: 28 }}>{transactions}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2, marginBottom: 4 }}>STATUS</div>
                    <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#00ff99', fontSize: 28 }}>ACTIVE</div>
                  </div>
                </div>
              </div>

              {/* Target circle graphic - RGB glow */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 130,
                  height: 130,
                  borderRadius: 65,
                  border: '3px solid rgba(255,50,150,0.5)',
                  marginLeft: 20,
                  boxShadow: '0 0 30px rgba(255,50,150,0.3), inset 0 0 20px rgba(255,50,150,0.1)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 90,
                    height: 90,
                    borderRadius: 45,
                    border: '2px solid rgba(150,50,255,0.4)',
                    boxShadow: '0 0 20px rgba(150,50,255,0.2)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 50,
                      height: 50,
                      borderRadius: 25,
                      border: '2px solid rgba(0,255,200,0.4)',
                      boxShadow: '0 0 15px rgba(0,255,200,0.3)',
                    }}
                  >
                    <div style={{ display: 'flex', width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,255,200,0.6)', boxShadow: '0 0 10px rgba(0,255,200,0.8)' }} />
                  </div>
                </div>
              </div>
            </div>

            {/* Reputation Progress Bar */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginTop: 20,
                marginBottom: 8,
              }}
            >
              {/* Label row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#666', fontSize: 10, letterSpacing: 2 }}>
                  REPUTATION
                </div>
                <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#ccc', fontSize: 12 }}>
                  {score}/100
                </div>
              </div>
              {/* Progress bar container */}
              <div
                style={{
                  display: 'flex',
                  width: '100%',
                  height: 12,
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.1)',
                  overflow: 'hidden',
                  boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.3)',
                }}
              >
                {/* Filled portion with RGB gradient */}
                <div
                  style={{
                    display: 'flex',
                    width: `${score}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, rgba(255,50,150,0.9) 0%, rgba(150,50,255,0.9) 33%, rgba(50,150,255,0.9) 66%, rgba(0,255,200,0.9) 100%)',
                    borderRadius: 5,
                    boxShadow: '0 0 10px rgba(0,255,200,0.5), 0 0 20px rgba(150,50,255,0.3)',
                  }}
                />
              </div>
            </div>

            {/* MRZ Zone - lighter for contrast */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                marginTop: 16,
                padding: '14px 18px',
                backgroundColor: 'rgba(255,255,255,0.08)',
                borderTop: '1px solid rgba(255,255,255,0.15)',
                boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.2)',
              }}
            >
              <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 13, letterSpacing: 3, color: '#888' }}>{mrzLine1}</div>
              <div style={{ display: 'flex', fontFamily: 'SpaceMono', fontSize: 13, letterSpacing: 3, color: '#888', marginTop: 2 }}>{mrzLine2}</div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#555', fontSize: 9, letterSpacing: 1 }}>
                AUTONOMOUS AGENT REGISTRY
              </div>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ display: 'flex', fontFamily: 'SpaceMono', color: '#555', fontSize: 9, marginRight: 12 }}>wildwestbots.com</div>
                <div style={{ display: 'flex', padding: '3px 10px', backgroundColor: 'rgba(50,150,255,0.2)', border: '1px solid rgba(50,150,255,0.3)' }}>
                  <div style={{ display: 'flex', fontFamily: 'SpaceMonoBold', color: '#5599ff', fontSize: 9 }}>BASE</div>
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
