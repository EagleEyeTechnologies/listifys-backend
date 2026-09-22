import { connectMongo } from "../db/mongo.js";
import { User } from "../modules/users/user.model.js";
import { Listing } from "../modules/listings/listing.model.js";
import { logger } from "../utils/logger.js";

async function seed() {
  await connectMongo();

  let seller = await User.findOne({ email: "demo@listifys.local" });
  if (!seller) {
    seller = await User.create({
      email: "demo@listifys.local",
      name: "Demo Seller",
      countryCode: "IN",
      providers: [{ provider: "email", providerId: "demo@listifys.local" }],
      avatar:
        "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&h=200&fit=crop&q=80",
    });
  }

  await Listing.deleteMany({ seller: seller._id, title: /^\[Seed\]/ });

  const samples = [
    {
      title: '[Seed] Samsung 55" 4K Smart TV',
      description: "Barely used Samsung 4K TV with remote and wall mount. Great picture.",
      category: "electronics" as const,
      subcategory: "TVs & Audio",
      intent: "sale" as const,
      price: 42000,
      currency: "INR",
      countryCode: "IN" as const,
      condition: "Like New",
      images: ["https://images.unsplash.com/photo-1593359677879-a4bb92f829d1?w=800&q=80"],
      location: "HITEC City, Hyderabad",
      city: "Hyderabad",
      coordinates: { type: "Point" as const, coordinates: [78.38, 17.44] },
      featured: true,
      extras: {
        electronics: { brand: "Samsung", model: "UA55", warranty: "Under warranty" },
      },
    },
    {
      title: "[Seed] 2BHK for Rent near Gachibowli",
      description: "Spacious 2BHK with balcony, parking, and 24x7 water.",
      category: "properties" as const,
      subcategory: "Apartment",
      intent: "sale" as const,
      price: 28000,
      currency: "INR",
      countryCode: "IN" as const,
      images: ["https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80"],
      location: "Gachibowli, Hyderabad",
      city: "Hyderabad",
      coordinates: { type: "Point" as const, coordinates: [78.35, 17.44] },
      extras: {
        property: {
          dealType: "rent",
          bedrooms: 2,
          bathrooms: 2,
          areaSqft: 1100,
          furnishing: "Semi-Furnished",
        },
      },
    },
    {
      title: "[Seed] Wanted: MacBook Air M2",
      description: "Looking for a clean MacBook Air M2 256GB in Hyderabad.",
      category: "electronics" as const,
      subcategory: "Computers",
      intent: "wanted" as const,
      price: 70000,
      currency: "INR",
      countryCode: "IN" as const,
      images: ["https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800&q=80"],
      location: "Madhapur, Hyderabad",
      city: "Hyderabad",
      coordinates: { type: "Point" as const, coordinates: [78.39, 17.45] },
      extras: { electronics: { brand: "Apple", model: "MacBook Air M2" } },
    },
    {
      title: "[Seed] Weekend babysitter — Jubilee Hills",
      description: "Experienced babysitter available evenings and weekends.",
      category: "takecare" as const,
      subcategory: "Babysitter",
      intent: "sale" as const,
      price: 350,
      currency: "INR",
      countryCode: "IN" as const,
      images: ["https://images.unsplash.com/photo-1476703993599-0035a21b17a9?w=800&q=80"],
      location: "Jubilee Hills, Hyderabad",
      city: "Hyderabad",
      coordinates: { type: "Point" as const, coordinates: [78.41, 17.43] },
      extras: {
        takeCare: {
          role: "Babysitter",
          experienceYears: 4,
          languages: ["English", "Hindi", "Telugu"],
        },
      },
    },
  ];

  await Listing.insertMany(
    samples.map((s) => ({
      ...s,
      seller: seller!._id,
      sellerName: seller!.name,
      sellerAvatar: seller!.avatar,
      status: "active",
    })),
  );

  let buyer = await User.findOne({ email: "buyer@listifys.local" });
  if (!buyer) {
    buyer = await User.create({
      email: "buyer@listifys.local",
      name: "Demo Buyer",
      countryCode: "IN",
      providers: [{ provider: "email", providerId: "buyer@listifys.local" }],
      avatar:
        "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&h=200&fit=crop&q=80",
    });
  }

  const { Conversation } = await import("../modules/chat/conversation.model.js");
  const { Message } = await import("../modules/chat/message.model.js");
  const listing = await Listing.findOne({
    seller: seller._id,
    title: /^\[Seed\]/,
  });

  let conversation = await Conversation.findOne({
    participants: { $all: [buyer._id, seller._id], $size: 2 },
  });
  if (!conversation) {
    conversation = await Conversation.create({
      participants: [buyer._id, seller._id],
      listingId: listing?._id || null,
      listingTitle: listing?.title || "Seed listing",
      listingImage: listing?.images?.[0] || "",
      listingPrice: listing?.price || 0,
      listingHref: listing ? `/${listing.category}/${listing._id}` : "/browse",
      lastMessageText: "Is this still available?",
      lastMessageAt: new Date(),
      unreadBy: {},
    });
    await Message.create({
      conversation: conversation._id,
      sender: buyer._id,
      text: "Is this still available?",
      kind: "text",
      readBy: [buyer._id],
    });
    await Message.create({
      conversation: conversation._id,
      sender: seller._id,
      text: "Yes, still available. When would you like to meet?",
      kind: "text",
      readBy: [seller._id],
    });
    conversation.lastMessageText = "Yes, still available. When would you like to meet?";
    conversation.lastMessageAt = new Date();
    await conversation.save();
  }

  const { Notification } = await import("../modules/notifications/notification.model.js");
  await Notification.deleteMany({
    user: { $in: [buyer._id, seller._id] },
    title: /^\[Seed\]/,
  });
  await Notification.insertMany([
    {
      user: buyer._id,
      type: "message",
      title: "[Seed] New reply from Demo Seller",
      body: "Yes, still available. When would you like to meet?",
      href: `/messages?c=${conversation._id.toString()}`,
      image: listing?.images?.[0] || "",
      read: false,
    },
    {
      user: seller._id,
      type: "message",
      title: "[Seed] Message from Demo Buyer",
      body: "Is this still available?",
      href: `/messages?c=${conversation._id.toString()}`,
      image: listing?.images?.[0] || "",
      read: false,
    },
    {
      user: buyer._id,
      type: "listing",
      title: "[Seed] Listing tip",
      body: "Save listings you like — they sync when you sign in.",
      href: "/saved",
      read: true,
    },
  ]);

  logger.info("Seed complete", {
    sellerId: seller._id.toString(),
    buyerId: buyer._id.toString(),
    listings: samples.length,
    conversationId: conversation._id.toString(),
  });
  process.exit(0);
}

seed().catch((err) => {
  logger.error("Seed failed", {
    err: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
