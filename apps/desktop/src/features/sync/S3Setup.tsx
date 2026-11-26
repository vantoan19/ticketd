import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ExternalLink } from "lucide-react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FailureAlert } from "@/components/ui/failure-alert";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusLabel } from "@/components/ui/status-label";
import {
  SettingsList,
  SettingsListFooter,
  SettingsRow,
} from "@/features/settings/layout/SettingsList";
import { workspaceClient } from "@/lib/api/workspace";
import {
  describeFailure,
  type FailureDescription,
} from "@/lib/api/describe-failure";
import { s3Api, type S3Profiles } from "@/lib/s3-api";
import { syncApi } from "@/lib/sync-api";
import { SyncFailure as Failure } from "./SyncFailure";
import { useCommand } from "./use-sync-command";
import "@/features/settings/settings.css";
import "./sync.css";

const INSTALL_URL =
  "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";
const DEFAULT_PREFIX = "ticketd/";

/** Says which version the AWS CLI is and which ticketd needs; the core words it the same. */
function tooOldMessage(found: string | null): string {
  return found
    ? `AWS CLI ${found} is too old. ticketd needs 2.13 or later.`
    : "ticketd could not read the AWS CLI's version. ticketd needs 2.13 or later.";
}

/** What the AWS CLI said about itself and its profiles; `null` while it is read. */
type Cli = S3Profiles | null;

/** Where one profile stands: signed in, or what it needs. */
type SignIn =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "signed_in"; identity: string }
  | { kind: "needed"; canSignIn: boolean; message: string }
  | { kind: "waiting" };

/**
 * Choosing S3 as the storage: a profile from the AWS CLI, its sign-in, the
 * bucket and the prefix. Every row is on the page from the start, so nothing
 * moves as the earlier ones are answered.
 */
export function S3Setup({ onBack }: { onBack?: () => void } = {}) {
  const [cli, setCli] = useState<Cli>(null);
  const [readFailure, setReadFailure] = useState<FailureDescription | null>(
    null,
  );
  const [profile, setProfile] = useState("");
  const [signIn, setSignIn] = useState<SignIn>({ kind: "none" });
  const [signInFailure, setSignInFailure] = useState<FailureDescription | null>(
    null,
  );
  // `undefined` while read; `null` when the profile may not list buckets.
  const [buckets, setBuckets] = useState<string[] | null | undefined>(
    undefined,
  );
  // The list could not be read, which is not the same as the profile not being allowed to.
  const [bucketsFailed, setBucketsFailed] = useState(false);
  const [bucket, setBucket] = useState("");
  // A bucket typed in, though the profile lists some: it may use more than it owns.
  const [typing, setTyping] = useState(false);
  const [prefix, setPrefix] = useState(DEFAULT_PREFIX);
  const { busy, failure, run, clear } = useCommand({ readable: true });
  // A check that started before another one must not put its answer back.
  const generation = useRef(0);

  /** Reads the AWS CLI's profiles; a person's only profile is chosen for them. */
  function loadProfiles(isCurrent: () => boolean = () => true) {
    s3Api
      .profiles()
      .then((read) => {
        if (!isCurrent()) return;
        setCli(read);
        const [only] = read.profiles;
        if (read.profiles.length === 1 && only) choose(only);
      })
      .catch((reason: unknown) => {
        if (!isCurrent()) return;
        setCli({ cli: { state: "ready" }, profiles: [] });
        setReadFailure(describeFailure(reason, "read your AWS profiles"));
      });
  }
  useEffect(() => {
    let live = true;
    loadProfiles(() => live);
    return () => {
      live = false;
    };
    // Read once, when the page opens; Check again reads it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function checkAgain() {
    setCli(null);
    setReadFailure(null);
    loadProfiles();
  }
  function choose(name: string) {
    setProfile(name);
    void check(name);
  }

  /** Who the profile is signed in as, then the buckets it may list. */
  async function check(
    name: string,
    /** A failure from the step before, which the check does not clear. */
    carried: FailureDescription | null = null,
  ) {
    const current = ++generation.current;
    setSignIn({ kind: "checking" });
    setSignInFailure(carried);
    setBuckets(undefined);
    setBucketsFailed(false);
    setBucket("");
    setTyping(false);
    try {
      const identity = await s3Api.identity(name);
      if (current !== generation.current) return;
      if (identity.state === "sign_in_needed") {
        setSignIn({
          kind: "needed",
          canSignIn: identity.can_sign_in,
          message: identity.message,
        });
        return;
      }
      setSignIn({ kind: "signed_in", identity: identity.identity });
      let listed: string[] | null = null;
      try {
        listed = await s3Api.buckets(name);
      } catch (reason) {
        // Only a refusal to list is `null`; any other failure is shown, and the name typed.
        if (current === generation.current) {
          setBucketsFailed(true);
          setSignInFailure(describeFailure(reason, "list your buckets"));
        }
      }
      if (current === generation.current) setBuckets(listed);
    } catch (reason) {
      if (current !== generation.current) return;
      setSignIn({ kind: "none" });
      setSignInFailure(describeFailure(reason, "check the AWS sign-in"));
    }
  }
  async function startSignIn() {
    // The profile chosen when it started, which the person may change while the browser
    // is open; a later choice owns the page, so this one's result is dropped.
    const started = profile;
    const current = generation.current;
    setSignIn({ kind: "waiting" });
    setSignInFailure(null);
    let failure: FailureDescription | null = null;
    try {
      await s3Api.signIn(started);
    } catch (reason) {
      failure = describeFailure(reason, "sign in to AWS");
    }
    if (current !== generation.current) return;
    await check(started, failure);
  }

  // Where the AWS CLI cannot answer yet, Back is still the way out of this step.
  const back = onBack && (
    <div className="sync-footer">
      <Button variant="ghost" size="sm" onClick={onBack}>
        Back
      </Button>
    </div>
  );
  if (cli === null) return <SetupSkeleton />;
  if (cli.cli.state !== "ready")
    return (
      <>
        <CliNotice
          state={cli.cli}
          onCheckAgain={checkAgain}
          failure={readFailure}
        />
        {back}
      </>
    );
  if (cli.profiles.length === 0)
    return (
      <>
        <NoProfiles onCheckAgain={checkAgain} failure={readFailure} />
        {back}
      </>
    );

  const signedIn = signIn.kind === "signed_in";
  const ready = signedIn && bucket.trim() !== "" && !busy;
  return (
    <div className="sync-block">
      <SettingsList>
        <SettingsRow
          variant="top"
          title={<Label htmlFor="s3-profile">AWS profile</Label>}
          description="From your AWS CLI configuration."
          trailing={
            <Select value={profile} onValueChange={choose}>
              <SelectTrigger id="s3-profile" className="w-60">
                <SelectValue placeholder="Choose a profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {cli.profiles.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        />
        <SignInRow
          signIn={signIn}
          onSignIn={() => void startSignIn()}
          onCheckAgain={() => void check(profile)}
        />
        <SettingsRow
          variant="top"
          title={<Label htmlFor="s3-bucket">Bucket</Label>}
          description={
            buckets === null
              ? bucketsFailed
                ? "The buckets could not be listed, so type the name."
                : "This profile may not list buckets, so type the name."
              : "The bucket that keeps this workspace."
          }
          trailing={
            <BucketField
              buckets={buckets}
              signedIn={signedIn}
              value={bucket}
              typing={typing}
              onChange={(value) => {
                setBucket(value);
                clear();
              }}
              onOther={() => {
                setBucket("");
                setTyping(true);
              }}
              onList={() => {
                setBucket("");
                setTyping(false);
              }}
            />
          }
        />
        <SettingsRow
          variant="top"
          title={<Label htmlFor="s3-prefix">Prefix</Label>}
          description="The folder in the bucket ticketd keeps its files in."
          trailing={
            <Input
              id="s3-prefix"
              className="w-60"
              value={prefix}
              disabled={!signedIn}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                setPrefix(event.target.value);
                clear();
              }}
            />
          }
        />
      </SettingsList>
      {signInFailure && (
        <FailureAlert
          size="compact"
          failure={signInFailure}
          className="mt-3"
          onRetry={() => void check(profile)}
        />
      )}
      <Failure>{failure}</Failure>
      <div className="sync-footer">
        <SettingsList>
          <SettingsListFooter
            actions={
              <>
                {onBack && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={onBack}
                  >
                    Back
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={!ready}
                  onClick={() =>
                    void run(
                      () =>
                        syncApi.connectS3({
                          bucket: bucket.trim(),
                          prefix,
                          profile,
                        }),
                      "connect S3",
                    )
                  }
                >
                  Connect S3
                </Button>
              </>
            }
          >
            ticketd does not encrypt the files it puts in the bucket.
          </SettingsListFooter>
        </SettingsList>
      </div>
    </div>
  );
}

function SignInRow({
  signIn,
  onSignIn,
  onCheckAgain,
}: {
  signIn: SignIn;
  onSignIn: () => void;
  onCheckAgain: () => void;
}) {
  switch (signIn.kind) {
    case "none":
      return (
        <SettingsRow
          title="Sign-in"
          description="Choose a profile to see whether it is signed in."
        />
      );
    case "checking":
      return (
        <SettingsRow
          title={<span role="status">Checking sign-in…</span>}
          description="Asking the AWS CLI."
        />
      );
    case "signed_in":
      return (
        <SettingsRow
          title={<StatusLabel tone="positive">Signed in</StatusLabel>}
          description={<span className="wrap-anywhere">{signIn.identity}</span>}
        />
      );
    case "waiting":
      return (
        <SettingsRow
          title={
            <span role="status" className="sync-waiting">
              Waiting for sign-in in your browser…
            </span>
          }
          description="Finish signing in there, then come back."
          trailing={
            <Button size="sm" disabled>
              Sign in
            </Button>
          }
        />
      );
    case "needed":
      return signIn.canSignIn ? (
        <SettingsRow
          title={<StatusLabel tone="neutral">Not signed in</StatusLabel>}
          description="Sign-in opens in your browser."
          trailing={
            <Button size="sm" onClick={onSignIn}>
              Sign in
              <ExternalLink aria-hidden="true" />
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title={<StatusLabel tone="neutral">Not signed in</StatusLabel>}
          description={
            <span className="wrap-anywhere">
              {signIn.message ||
                "This profile has no sign-in command. Sign in with the AWS CLI."}{" "}
              Then check again.
            </span>
          }
          trailing={
            <Button size="sm" variant="outline" onClick={onCheckAgain}>
              Check again
            </Button>
          }
        />
      );
  }
}

/** The value of the list's last choice, which turns the field into a typed name. */
const OTHER_BUCKET = "\u0000other";

/** A list when the profile may list buckets, with a way to type one it does not show. */
function BucketField({
  buckets,
  signedIn,
  value,
  typing,
  onChange,
  onOther,
  onList,
}: {
  buckets: string[] | null | undefined;
  signedIn: boolean;
  value: string;
  typing: boolean;
  onChange: (value: string) => void;
  onOther: () => void;
  /** Back to the list, when the profile lists buckets. */
  onList: () => void;
}) {
  if (signedIn && buckets === undefined)
    return <Skeleton className="h-10 w-60" />;
  if (buckets && buckets.length > 0 && !typing)
    return (
      <Select
        value={value}
        onValueChange={(chosen) =>
          chosen === OTHER_BUCKET ? onOther() : onChange(chosen)
        }
      >
        <SelectTrigger id="s3-bucket" className="w-60" title={value}>
          <SelectValue placeholder="Choose a bucket" />
        </SelectTrigger>
        {/* The list is as wide as its field and starts at its edge; a long name is cut, whole on hover. */}
        <SelectContent className="w-(--radix-select-trigger-width) max-w-(--radix-select-trigger-width)">
          <SelectGroup>
            {buckets.map((name) => (
              <SelectItem
                key={name}
                value={name}
                title={name}
                className="*:[span]:last:min-w-0"
              >
                <span className="min-w-0 truncate">{name}</span>
              </SelectItem>
            ))}
            <SelectItem value={OTHER_BUCKET}>Another bucket…</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  // The field and the way back to the list (an icon button) share the list's 240px, and both
  // are at most 40px tall. The row's trailing slot is then the same size in both states, so the
  // description keeps its width (and lines) and nothing below moves.
  return (
    <div className="flex w-60 shrink-0 items-center gap-1">
      <Input
        id="s3-bucket"
        value={value}
        disabled={!signedIn}
        placeholder="my-bucket"
        spellCheck={false}
        autoComplete="off"
        autoFocus={typing}
        onChange={(event) => onChange(event.target.value)}
      />
      {typing && (
        <IconButton
          label="Choose from the list"
          className="shrink-0"
          onClick={onList}
        >
          <ChevronDownIcon />
        </IconButton>
      )}
    </div>
  );
}

/** Rows in the shape of the setup rows, while the AWS CLI is asked. */
function SetupSkeleton() {
  return (
    <div className="sync-block" role="status" aria-label="Reading AWS profiles">
      <SettingsList>
        <SettingsRow
          title={<Skeleton className="h-5 w-32" />}
          description={<Skeleton className="mt-1 h-4 w-56 max-w-full" />}
          trailing={<Skeleton className="h-10 w-60" />}
        />
      </SettingsList>
    </div>
  );
}

function CliNotice({
  state,
  onCheckAgain,
  failure,
}: {
  state: Exclude<S3Profiles["cli"], { state: "ready" }>;
  onCheckAgain: () => void;
  failure: FailureDescription | null;
}) {
  const [linkFailure, setLinkFailure] = useState<FailureDescription | null>(
    null,
  );
  const [chooseFailure, setChooseFailure] = useState<FailureDescription | null>(
    null,
  );
  function chooseProgram() {
    setChooseFailure(null);
    s3Api
      .chooseCli()
      .then((chosen) => {
        if (chosen) onCheckAgain();
      })
      .catch((reason: unknown) =>
        setChooseFailure(describeFailure(reason, "use that program")),
      );
  }
  return (
    <div className="sync-block">
      <Alert role="status" tone="attention">
        <AlertTitle>
          {state.state === "missing"
            ? "The AWS CLI isn't installed"
            : "The AWS CLI is too old"}
        </AlertTitle>
        <AlertDescription>
          {state.state === "missing"
            ? "ticketd signs in to AWS through the AWS CLI, version 2.13 or later. Install it, then check again."
            : `${tooOldMessage(state.found)} Update it, then check again.`}
        </AlertDescription>
        <AlertActions>
          <Button size="sm" onClick={onCheckAgain}>
            Check again
          </Button>
          <Button size="sm" variant="outline" onClick={chooseProgram}>
            Choose the aws program…
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLinkFailure(null);
              workspaceClient
                .openLink(INSTALL_URL)
                .catch((reason: unknown) =>
                  setLinkFailure(describeFailure(reason, "open the AWS guide")),
                );
            }}
          >
            How to install
            <ExternalLink aria-hidden="true" />
          </Button>
        </AlertActions>
      </Alert>
      <Failure>{failure ?? chooseFailure ?? linkFailure}</Failure>
    </div>
  );
}

function NoProfiles({
  onCheckAgain,
  failure,
}: {
  onCheckAgain: () => void;
  failure: FailureDescription | null;
}) {
  return (
    <div className="sync-block">
      <Alert role="status" tone="attention">
        <AlertTitle>No AWS profiles found</AlertTitle>
        <AlertDescription>
          Create one in a terminal with <code>aws configure sso</code>, or{" "}
          <code>aws configure</code> for access keys. Then check again.
        </AlertDescription>
        <AlertActions>
          <Button size="sm" onClick={onCheckAgain}>
            Check again
          </Button>
        </AlertActions>
      </Alert>
      <Failure>{failure}</Failure>
    </div>
  );
}
