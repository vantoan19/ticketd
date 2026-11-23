// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { workspaceClient } from "@/lib/api/workspace";
import { s3Api, type S3Identity, type S3Profiles } from "@/lib/s3-api";
import { syncApi } from "@/lib/sync-api";
import { revealFailureDetails } from "@/test/failure-details";
import { S3Connected, S3Setup } from "./S3Setup";
import { SyncStatusProvider } from "./SyncStatusProvider";
import { hostFailure, syncStatus } from "./sync-fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/s3-api", async (original) => ({
  ...(await original<typeof import("@/lib/s3-api")>()),
  s3Api: {
    profiles: vi.fn(),
    identity: vi.fn(),
    signIn: vi.fn(),
    buckets: vi.fn(),
  },
}));
vi.mock("@/lib/sync-api", async (original) => ({
  ...(await original<typeof import("@/lib/sync-api")>()),
  syncApi: { status: vi.fn(), connectS3: vi.fn(), disconnect: vi.fn() },
}));
vi.mock("@/lib/api/workspace", () => ({
  workspaceClient: { openLink: vi.fn() },
}));
Element.prototype.scrollIntoView ??= () => {};
const s3 = vi.mocked(s3Api);
const sync = vi.mocked(syncApi);

const ARN = "arn:aws:sts::123456789012:assumed-role/Admin/mina";
const ready = (...profiles: string[]): S3Profiles => ({
  cli: { state: "ready" },
  profiles,
});
const signedIn: S3Identity = { state: "signed_in", identity: ARN };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function show() {
  sync.status.mockResolvedValue(
    syncStatus({
      connection: "not_connected",
      account: null,
      folder: null,
      state: "saved_locally",
      last_synced_at: null,
    }),
  );
  return render(
    <SyncStatusProvider>
      <S3Setup />
    </SyncStatusProvider>,
  );
}

/** Opens a Radix select by its trigger and picks the option. */
async function choose(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

test("a missing AWS CLI says to install it, and Check again looks once more", async () => {
  s3.profiles.mockResolvedValueOnce({
    cli: { state: "missing" },
    profiles: [],
  });
  show();
  expect(await screen.findByText("The AWS CLI isn't installed")).toBeTruthy();
  expect(screen.queryByLabelText("AWS profile")).toBeNull();

  s3.profiles.mockResolvedValueOnce(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByLabelText("AWS profile")).toBeTruthy();
  expect(s3.profiles).toHaveBeenCalledTimes(2);
});

test("an old AWS CLI names the version it found", async () => {
  s3.profiles.mockResolvedValue({
    cli: { state: "too_old", found: "aws-cli/1.27.0" },
    profiles: [],
  });
  show();
  expect(await screen.findByText("The AWS CLI is too old")).toBeTruthy();
  expect(screen.getByText(/aws-cli\/1\.27\.0/)).toBeTruthy();
});

test("the install guide opens through the app", async () => {
  s3.profiles.mockResolvedValue({ cli: { state: "missing" }, profiles: [] });
  vi.mocked(workspaceClient.openLink).mockResolvedValue(undefined);
  show();
  fireEvent.click(
    await screen.findByRole("button", { name: /How to install/ }),
  );
  expect(workspaceClient.openLink).toHaveBeenCalledWith(
    expect.stringContaining("docs.aws.amazon.com/cli"),
  );
});

test("without profiles it says how to make one", async () => {
  s3.profiles.mockResolvedValue(ready());
  show();
  expect(await screen.findByText("No AWS profiles found")).toBeTruthy();
  expect(screen.getByText("aws configure sso")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect S3" })).toBeNull();
});

test("a profile signed in lists its buckets and connects with the chosen bucket and the default prefix", async () => {
  s3.profiles.mockResolvedValue(ready("work", "personal"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(["alpha", "team-ticketd"]);
  sync.connectS3.mockResolvedValue(
    syncStatus({ connection: "choosing", provider: "s3", folder: null }),
  );
  show();
  await choose(
    await screen.findByRole("combobox", { name: "AWS profile" }),
    "work",
  );
  expect(s3.identity).toHaveBeenCalledWith("work");
  expect(await screen.findByText("Signed in")).toBeTruthy();
  expect(screen.getByText(ARN)).toBeTruthy();

  const connect = screen.getByRole("button", {
    name: "Connect S3",
  }) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  expect((screen.getByLabelText("Prefix") as HTMLInputElement).value).toBe(
    "ticketd/",
  );
  await choose(
    await screen.findByRole("combobox", { name: "Bucket" }),
    "team-ticketd",
  );
  expect(connect.disabled).toBe(false);
  fireEvent.click(connect);
  await waitFor(() =>
    expect(sync.connectS3).toHaveBeenCalledWith({
      bucket: "team-ticketd",
      prefix: "ticketd/",
      profile: "work",
    }),
  );
});

test("a profile that may not list buckets gets a field to type the name", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  sync.connectS3.mockResolvedValue(
    syncStatus({ connection: "choosing", provider: "s3", folder: null }),
  );
  show();
  // The only profile is chosen for the person.
  const bucket = (await screen.findByLabelText("Bucket")) as HTMLInputElement;
  await waitFor(() => expect(bucket.disabled).toBe(false));
  expect(screen.getByText(/may not list buckets/)).toBeTruthy();
  fireEvent.change(bucket, { target: { value: " my-bucket " } });
  fireEvent.change(screen.getByLabelText("Prefix"), {
    target: { value: "team/ticketd" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect S3" }));
  await waitFor(() =>
    expect(sync.connectS3).toHaveBeenCalledWith({
      bucket: "my-bucket",
      prefix: "team/ticketd",
      profile: "work",
    }),
  );
});

test("Sign in runs the profile's sign-in and then checks again", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity
    .mockResolvedValueOnce({
      state: "sign_in_needed",
      can_sign_in: true,
      message: "Error loading SSO Token",
    })
    .mockResolvedValueOnce(signedIn);
  s3.buckets.mockResolvedValue(["alpha"]);
  let finish = () => {};
  s3.signIn.mockReturnValue(
    new Promise((resolve) => (finish = () => resolve())),
  );
  show();
  expect(await screen.findByText("Not signed in")).toBeTruthy();
  // Nothing below the sign-in can be filled in yet.
  expect((screen.getByLabelText("Bucket") as HTMLInputElement).disabled).toBe(
    true,
  );
  expect((screen.getByLabelText("Prefix") as HTMLInputElement).disabled).toBe(
    true,
  );

  fireEvent.click(screen.getByRole("button", { name: /Sign in/ }));
  expect(s3.signIn).toHaveBeenCalledWith("work");
  expect(
    await screen.findByText("Waiting for sign-in in your browser…"),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);

  finish();
  expect(await screen.findByText("Signed in")).toBeTruthy();
  expect(s3.identity).toHaveBeenCalledTimes(2);
});

test("a failed sign-in is reported and the profile stays signed out", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue({
    state: "sign_in_needed",
    can_sign_in: true,
    message: "",
  });
  s3.signIn.mockImplementation(async () => {
    throw hostFailure(
      "The AWS CLI failed (exit code 255): login was cancelled",
    );
  });
  show();
  fireEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain(
    "login was cancelled",
  );
  expect(await screen.findByText("Not signed in")).toBeTruthy();
  expect(screen.queryByText("Signed in")).toBeNull();
});

test("a profile with no sign-in command shows the CLI's words and can be checked again", async () => {
  s3.profiles.mockResolvedValue(ready("keys"));
  s3.identity
    .mockResolvedValueOnce({
      state: "sign_in_needed",
      can_sign_in: false,
      message: "Unable to locate credentials.",
    })
    .mockResolvedValueOnce(signedIn);
  s3.buckets.mockResolvedValue(null);
  show();
  expect(await screen.findByText(/Unable to locate credentials/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Sign in/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Signed in")).toBeTruthy();
});

test("a long bucket name stays inside its field", async () => {
  const long = "a-very-long-bucket-name-".repeat(3) + "end";
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue([long]);
  show();
  const trigger = await screen.findByRole("combobox", { name: "Bucket" });
  await choose(trigger, long);
  // The field keeps its width; the text is cut with an ellipsis.
  expect(trigger.className).toContain("w-60");
  expect(trigger.textContent).toContain(long);
});

test("connected to S3, the page names the bucket, prefix and profile and offers Disconnect", async () => {
  const connected = syncStatus({
    connection: "choosing",
    provider: "s3",
    account: ARN,
    folder: null,
    s3: {
      bucket: "team-ticketd",
      prefix: "ticketd/",
      profile: "work",
      aws_cli_path: null,
    },
  });
  sync.status.mockResolvedValue(connected);
  sync.disconnect.mockResolvedValue(
    syncStatus({ connection: "not_connected", account: null, folder: null }),
  );
  render(
    <SyncStatusProvider>
      <S3Connected status={connected} />
    </SyncStatusProvider>,
  );
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(screen.getByText(ARN)).toBeTruthy();
  expect(
    screen.getByText("s3://team-ticketd/ticketd/ · profile work"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(sync.disconnect).toHaveBeenCalled());
});

test("the sync commands go over the bridge with the host's names", async () => {
  vi.mocked(invoke).mockResolvedValue({
    cli: { state: "ready" },
    profiles: ["work"],
  });
  const real = (
    await vi.importActual<typeof import("@/lib/s3-api")>("@/lib/s3-api")
  ).s3Api;
  expect(await real.profiles()).toEqual(ready("work"));
  expect(invoke).toHaveBeenCalledWith("s3_profiles");
  vi.mocked(invoke).mockResolvedValue(null);
  expect(await real.buckets("work")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("s3_buckets", { profile: "work" });
});
