import { lookup } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
const denied = new BlockList();
for (const [address, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) denied.addSubnet(address, prefix, "ipv4");
export const isPublicAddress = (address: string) => isIPv4(address) && !denied.check(address, "ipv4");

export class PublicTargetError extends Error {}
export async function resolvePublicHost(hostname: string) {
  let timer: ReturnType<typeof setTimeout>;
  const addresses = await Promise.race([lookup(hostname, { all: true, family: 4 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 3000); })]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new PublicTargetError("The destination does not resolve to an allowed public address.");
  return addresses[0].address;
}
