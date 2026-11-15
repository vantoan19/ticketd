/** Above the composer of a Chat the person took over from a run. */
export function TakenOverLine({
  automationName,
  onViewRun,
}: {
  automationName: string;
  onViewRun: () => void;
}) {
  return (
    <>
      You took this over from a run of {automationName || "an Automation"}. The
      run ended here.{" "}
      <button type="button" className="settings-link" onClick={onViewRun}>
        View run
      </button>
    </>
  );
}
