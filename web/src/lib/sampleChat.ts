// A synthetic WhatsApp "Export chat → Without media" file (Android layout) for the import demo. Invented names and orders.
// It exercises what the importer handles: the encryption notice, a multi-line message, a sender burst that becomes one
// order, the distributor's own replies (excluded by name), a media placeholder, and a chatter-only message that is skipped.
export const SAMPLE_CHAT_DISTRIBUTOR = "Sharma Distributors";

export function sampleChatExport(now = new Date()): string {
  const d = `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getFullYear()).slice(2)}`;
  return [
    `${d}, 8:58 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.`,
    `${d}, 9:05 am - Raju Kirana: Bhai order likho`,
    `maggi 70g 3 peti`,
    `parle g 10 wala 2 peti`,
    `${d}, 9:06 am - Raju Kirana: surf excel 4`,
    `${d}, 9:07 am - Raju Kirana: jaldi bhejna`,
    `${d}, 9:30 am - ${SAMPLE_CHAT_DISTRIBUTOR}: ok bhai, shaam tak`,
    `${d}, 10:12 am - Gupta General Store: <Media omitted>`,
    `${d}, 10:13 am - Gupta General Store: clinic plus 1rs 10 ladi`,
    `blue lays 20rs 1 box`,
    `tata salt 1kg 2 bori`,
    `${d}, 10:40 am - ${SAMPLE_CHAT_DISTRIBUTOR}: noted`,
    `${d}, 11:02 am - Patel Provision: kal wala order bhi bhejna, thanks`,
    `${d}, 11:20 am - Khan Brothers: vim bar 3 dozen`,
    `everest kitchen king 100g 2 dabba`,
    `rin liquid 1L 3 peti`,
  ].join("\n") + "\n";
}
