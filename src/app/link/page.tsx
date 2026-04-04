import LinkForm from './LinkForm'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const { code } = await searchParams
  const initialCode = code || ''

  return <LinkForm initialCode={initialCode} />
}
