export class LobbyDO implements DurableObject {
  async fetch(): Promise<Response> {
    return new Response('lobby: not implemented yet', { status: 501 })
  }
}
