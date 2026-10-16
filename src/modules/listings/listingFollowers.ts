import { User } from "../users/user.model.js";
import { createNotification } from "../notifications/notification.service.js";
import { getIo } from "../chat/socket.js";
import { absolutizeMediaUrl } from "../../utils/mediaUrl.js";
import { logger } from "../../utils/logger.js";

const BATCH_SIZE = 50;

/** Tell everyone following the seller that they posted something new. */
export async function notifyFollowersOfNewListing(input: {
  sellerId: string;
  sellerName: string;
  listingId: string;
  title: string;
  image?: string;
}) {
  try {
    const seller = await User.findById(input.sellerId).select("followers blockedUsers");
    const blockedBySeller = new Set((seller?.blockedUsers || []).map(String));
    const followerIds = (seller?.followers || [])
      .map(String)
      .filter((id) => id !== input.sellerId && !blockedBySeller.has(id));
    if (!followerIds.length) return;

    const followers = await User.find({
      _id: { $in: followerIds },
      isActive: { $ne: false },
      scheduledDeletionAt: null,
      blockedUsers: { $ne: input.sellerId },
    }).select("_id");

    const name = input.sellerName.trim() || "Someone you follow";
    const title = `${name} posted a new listing`;
    const body = `“${input.title}” is now live on Listifys. Take a look before it’s gone.`;
    const href = `/listing/${input.listingId}`;
    const image = input.image ? absolutizeMediaUrl(input.image) : undefined;

    for (let i = 0; i < followers.length; i += BATCH_SIZE) {
      await Promise.all(
        followers.slice(i, i + BATCH_SIZE).map(async (follower) => {
          const userId = follower._id.toString();
          try {
            await createNotification({ userId, type: "listing", title, body, href, image });
            getIo()?.to(`user:${userId}`).emit("notification:new", { title, body });
          } catch (err) {
            logger.warn("Failed to notify follower about new listing", {
              userId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    }
  } catch (err) {
    logger.warn("Failed to notify followers about new listing", {
      listingId: input.listingId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
