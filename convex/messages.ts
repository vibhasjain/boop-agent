import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const send = mutation({
  args: {
    conversationId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    content: v.string(),
    agentId: v.optional(v.string()),
    turnId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const id = await ctx.db.insert("messages", { ...args, createdAt: now });

    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (conv) {
      await ctx.db.patch(conv._id, {
        messageCount: conv.messageCount + 1,
        lastActivityAt: now,
      });
    } else {
      await ctx.db.insert("conversations", {
        conversationId: args.conversationId,
        messageCount: 1,
        lastActivityAt: now,
      });
    }
    return id;
  },
});

export const list = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const recent = query({
  args: { conversationId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 20);
    return msgs.reverse();
  },
});

// Delete every message in a conversation older than `before` (a Unix
// epoch ms timestamp). Used to clear pre-cutover history so we don't
// keep replaying old, broken turns. Decrements the conversation's
// messageCount by the number actually deleted.
export const deleteBefore = mutation({
  args: { conversationId: v.string(), before: v.number() },
  handler: async (ctx, args) => {
    const toDelete = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.lt(q.field("createdAt"), args.before))
      .collect();
    for (const m of toDelete) {
      await ctx.db.delete(m._id);
    }
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    if (conv) {
      await ctx.db.patch(conv._id, {
        messageCount: Math.max(0, conv.messageCount - toDelete.length),
      });
    }
    return { deleted: toDelete.length };
  },
});
