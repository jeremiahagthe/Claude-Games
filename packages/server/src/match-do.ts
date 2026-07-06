export class MatchDO implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('match: not implemented yet', { status: 501 })
  }
}
