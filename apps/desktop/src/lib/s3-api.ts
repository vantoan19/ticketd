import { z } from "zod";
import { invoke as bridge, structured } from "@/lib/api/bridge-failure";

/**
 * The desktop's contract with the core for choosing S3 as the storage of
 * Workspace sync (ADR 0018). The AWS CLI signs the person in; ticketd stores
 * no AWS secret. Recording the connection is `syncApi.connectS3`.
 */

const profilesSchema = z.object({
  /** `missing`: no `aws` program found. `too_old`: older than ticketd needs. */
  cli: z.discriminatedUnion("state", [
    z.object({ state: z.literal("ready") }),
    z.object({ state: z.literal("missing") }),
    z.object({ state: z.literal("too_old"), found: z.string() }),
  ]),
  /** Empty unless the CLI is ready. */
  profiles: z.array(z.string()),
});
export type S3Profiles = z.infer<typeof profilesSchema>;

const identitySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("signed_in"),
    /** The ARN the profile signs in as. */
    identity: z.string(),
  }),
  z.object({
    state: z.literal("sign_in_needed"),
    /** Whether the profile has a sign-in command (SSO, console login). */
    can_sign_in: z.boolean(),
    /** The AWS CLI's own words. */
    message: z.string(),
  }),
]);
export type S3Identity = z.infer<typeof identitySchema>;

const invoke = (...call: Parameters<typeof bridge>) =>
  structured(bridge<unknown>(...call));

export const s3Api = {
  /** `s3_profiles`: the AWS CLI's state and the profile names in its configuration. */
  async profiles(): Promise<S3Profiles> {
    return profilesSchema.parse(await invoke("s3_profiles"));
  },

  /** `s3_identity`: who the profile is signed in as, or that it needs signing in. */
  async identity(profile: string): Promise<S3Identity> {
    return identitySchema.parse(await invoke("s3_identity", { profile }));
  },

  /**
   * `s3_sign_in`: runs the profile's sign-in command (`aws sso login`), which
   * waits for the person in their browser. Resolves once they finished.
   */
  async signIn(profile: string): Promise<void> {
    await invoke("s3_sign_in", { profile });
  },

  /** `s3_buckets`: the bucket names the profile may list, or `null` when it may not. */
  async buckets(profile: string): Promise<string[] | null> {
    return z
      .array(z.string())
      .nullable()
      .parse(await invoke("s3_buckets", { profile }));
  },
};
