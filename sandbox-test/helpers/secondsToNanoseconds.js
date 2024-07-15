export default function secondsToNanoseconds(seconds) {
  const nanosecondsPerSecond = 1e9
  return seconds * nanosecondsPerSecond
}
