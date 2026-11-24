// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { workspaceClient } from "@/lib/api/workspace";
import { s3Api, type S3Identity, type S3Profiles } from "@/lib/s3-api";
import { syncApi } from "@/lib/sync-api";
import { revealFailureDetails } from "@/test/failure-details";
import { S3Setup } from "./S3Setup";
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
    chooseCli: vi.fn(),
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

test("an old AWS CLI names the version it found and the one needed", async () => {
  s3.profiles.mockResolvedValue({
    cli: { state: "too_old", found: "1.27.0" },
    profiles: [],
  });
  show();
  expect(await screen.findByText("The AWS CLI is too old")).toBeTruthy();
  expect(
    screen.getByText(
      /AWS CLI 1\.27\.0 is too old\. ticketd needs 2\.13 or later\./,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/aws-cli\//)).toBeNull();
});

test("an AWS CLI whose version cannot be read says so", async () => {
  s3.profiles.mockResolvedValue({
    cli: { state: "too_old", found: null },
    profiles: [],
  });
  show();
  await screen.findByText("The AWS CLI is too old");
  expect(screen.getByText(/could not read the AWS CLI's version/)).toBeTruthy();
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

test("a program chosen for a missing or old AWS CLI is checked, then the profiles are read again", async () => {
  s3.profiles.mockResolvedValueOnce({
    cli: { state: "too_old", found: "1.27.0" },
    profiles: [],
  });
  show();
  await screen.findByText("The AWS CLI is too old");

  s3.chooseCli.mockResolvedValue(true);
  s3.profiles.mockResolvedValueOnce(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  fireEvent.click(
    screen.getByRole("button", { name: "Choose the aws program…" }),
  );
  expect(await screen.findByLabelText("AWS profile")).toBeTruthy();
  expect(s3.profiles).toHaveBeenCalledTimes(2);
});

test("cancelling the file picker changes nothing, and a program ticketd refuses says why", async () => {
  s3.profiles.mockResolvedValue({ cli: { state: "missing" }, profiles: [] });
  show();
  const choose = await screen.findByRole("button", {
    name: "Choose the aws program…",
  });

  s3.chooseCli.mockResolvedValueOnce(false);
  fireEvent.click(choose);
  await waitFor(() => expect(s3.chooseCli).toHaveBeenCalledTimes(1));
  expect(s3.profiles).toHaveBeenCalledTimes(1);

  s3.chooseCli.mockRejectedValueOnce(
    hostFailure("ticketd needs AWS CLI version 2.13 or later"),
  );
  fireEvent.click(choose);
  await revealFailureDetails();
  expect(
    await screen.findByText(/ticketd needs AWS CLI version 2\.13 or later/),
  ).toBeTruthy();
  expect(screen.getByText("The AWS CLI isn't installed")).toBeTruthy();
  expect(s3.profiles).toHaveBeenCalledTimes(1);
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

test("a bucket the list does not show can be typed instead", async () => {
  // ListBuckets returns the buckets the account owns, not every one it may use.
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(["alpha"]);
  sync.connectS3.mockResolvedValue(
    syncStatus({ connection: "choosing", provider: "s3", folder: null }),
  );
  show();
  await choose(
    await screen.findByRole("combobox", { name: "Bucket" }),
    "Another bucket…",
  );
  const typed = (await screen.findByLabelText("Bucket")) as HTMLInputElement;
  expect(typed.tagName).toBe("INPUT");
  fireEvent.change(typed, { target: { value: " team-bucket " } });
  fireEvent.click(screen.getByRole("button", { name: "Connect S3" }));
  await waitFor(() =>
    expect(sync.connectS3).toHaveBeenCalledWith({
      bucket: "team-bucket",
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

test("a refused bucket name says what to fix in the headline, not that the result is unknown", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  sync.connectS3.mockRejectedValue(
    hostFailure(
      "that is not a valid S3 bucket name; use 3 to 63 lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit",
    ),
  );
  show();
  const bucket = (await screen.findByLabelText("Bucket")) as HTMLInputElement;
  await waitFor(() => expect(bucket.disabled).toBe(false));
  fireEvent.change(bucket, { target: { value: "qa-2026-11-24/" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect S3" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Couldn't connect S3.");
  expect(alert.textContent).toContain(
    "That is not a valid S3 bucket name; use 3 to 63 lowercase letters",
  );
  expect(alert.textContent).not.toContain("couldn't be confirmed");
  expect(alert.textContent).not.toContain("saved state");
  // Nothing was saved, so there is nothing to retry as it stands.
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a failed bucket listing is shown, and only a refusal to list says the profile may not", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockImplementation(async () => {
    throw hostFailure("The AWS CLI failed (exit code 255): could not connect");
  });
  show();
  const bucket = (await screen.findByLabelText("Bucket")) as HTMLInputElement;
  await waitFor(() => expect(bucket.disabled).toBe(false));
  await revealFailureDetails();
  expect(screen.getByRole("alert").textContent).toContain("could not connect");
  expect(screen.queryByText(/may not list buckets/)).toBeNull();
  // The name can still be typed.
  fireEvent.change(bucket, { target: { value: "my-bucket" } });
  expect(bucket.value).toBe("my-bucket");
});

test("a sign-in that finishes after another profile was chosen does not replace that profile's state", async () => {
  s3.profiles.mockResolvedValue(ready("work", "personal"));
  s3.identity.mockImplementation(async (name: string) =>
    name === "work"
      ? { state: "sign_in_needed", can_sign_in: true, message: "" }
      : { state: "signed_in", identity: "arn:personal" },
  );
  s3.buckets.mockResolvedValue(null);
  let finish = () => {};
  s3.signIn.mockReturnValue(
    new Promise((resolve) => (finish = () => resolve())),
  );
  show();
  await choose(
    await screen.findByRole("combobox", { name: "AWS profile" }),
    "work",
  );
  fireEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
  expect(
    await screen.findByText("Waiting for sign-in in your browser…"),
  ).toBeTruthy();

  // The person picks the other profile while the browser sign-in of the first is open.
  await choose(
    screen.getByRole("combobox", { name: "AWS profile" }),
    "personal",
  );
  expect(await screen.findByText("arn:personal")).toBeTruthy();

  finish();
  await waitFor(() => expect(s3.signIn).toHaveBeenCalledTimes(1));
  // Work's result is not checked again, and does not take the page back.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(s3.identity).toHaveBeenCalledTimes(2);
  expect(screen.getByText("arn:personal")).toBeTruthy();
  expect(screen.queryByText("Not signed in")).toBeNull();
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
  // Cut with an ellipsis (a truncating box of its own, since the trigger is a flex row),
  // and the whole name on hover.
  expect(trigger.getAttribute("title")).toBe(long);
  const text = within(trigger).getByText(long);
  expect(text.className).toContain("truncate");
});

test("a bucket typed in can go back to the list when the profile lists buckets", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(["alpha"]);
  show();
  await choose(
    await screen.findByRole("combobox", { name: "Bucket" }),
    "Another bucket…",
  );
  expect(
    ((await screen.findByLabelText("Bucket")) as HTMLElement).tagName,
  ).toBe("INPUT");
  fireEvent.click(screen.getByRole("button", { name: "Choose from the list" }));
  await choose(
    await screen.findByRole("combobox", { name: "Bucket" }),
    "alpha",
  );
  expect(
    screen.queryByRole("button", { name: "Choose from the list" }),
  ).toBeNull();
});

test("the typed field takes the list's place without changing the row's text or width", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(["alpha"]);
  show();
  const trigger = await screen.findByRole("combobox", { name: "Bucket" });
  const description = "The bucket that keeps this workspace.";
  const slot = (control: HTMLElement) =>
    control.closest(".settings-list-row-trailing") as HTMLElement;
  expect(screen.getByText(description)).toBeTruthy();
  const listed = slot(trigger);
  expect(trigger.className).toContain("w-60");

  await choose(trigger, "Another bucket…");
  const input = (await screen.findByLabelText("Bucket")) as HTMLElement;
  // jsdom has no layout, so this pins what keeps the row's height: the same description, and a
  // trailing slot of the same 240px (w-60) shared by the field and the way back (an icon), so
  // nothing takes the description's width or adds a line.
  expect(screen.getByText(description)).toBeTruthy();
  expect(slot(input)).toBe(listed);
  const field = input.parentElement as HTMLElement;
  expect(field.className).toContain("w-60");
  const back = screen.getByRole("button", { name: "Choose from the list" });
  expect(back.parentElement).toBe(field);
  expect(back.className).toContain("shrink-0");
  expect(back.textContent).toBe("");
});

test("a profile that may not list buckets has no list to go back to", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  show();
  await screen.findByLabelText("Bucket");
  expect(
    screen.queryByRole("button", { name: "Choose from the list" }),
  ).toBeNull();
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
  vi.mocked(invoke).mockResolvedValue({
    address: "s3://b/p/f/",
    console: true,
  });
  expect(await real.folderLinks()).toEqual({
    address: "s3://b/p/f/",
    console: true,
  });
  expect(invoke).toHaveBeenCalledWith("s3_folder_links");
});

test("a refusal goes away as soon as the bucket or the prefix is edited", async () => {
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue(null);
  sync.connectS3.mockRejectedValue(
    hostFailure("that is not a valid S3 bucket name"),
  );
  show();
  const bucket = (await screen.findByLabelText("Bucket")) as HTMLInputElement;
  await waitFor(() => expect(bucket.disabled).toBe(false));
  const refuse = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Connect S3" }));
    await screen.findByRole("alert");
  };
  fireEvent.change(bucket, { target: { value: "bad/" } });
  await refuse();
  fireEvent.change(bucket, { target: { value: "bad" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await refuse();
  fireEvent.change(screen.getByLabelText("Prefix"), {
    target: { value: "other/" },
  });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("the open list is as wide as its field and cuts long names, whole on hover", async () => {
  const long = "a-very-long-bucket-name-".repeat(3) + "end";
  s3.profiles.mockResolvedValue(ready("work"));
  s3.identity.mockResolvedValue(signedIn);
  s3.buckets.mockResolvedValue([long, "alpha"]);
  show();
  fireEvent.click(await screen.findByRole("combobox", { name: "Bucket" }));
  const option = await screen.findByRole("option", { name: long });
  expect(option.getAttribute("title")).toBe(long);
  expect(within(option).getByText(long).className).toContain("truncate");
  const list = screen
    .getByRole("listbox")
    .closest("[data-slot=select-content]");
  expect(list?.className).toContain("w-(--radix-select-trigger-width)");
  expect(list?.className).toContain("max-w-(--radix-select-trigger-width)");
});
