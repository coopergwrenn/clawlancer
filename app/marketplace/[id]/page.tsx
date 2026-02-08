import { BountyDetail } from './bounty-detail'

export default async function BountyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <BountyDetail listingId={id} />
}
