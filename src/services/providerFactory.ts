import { SportsDataProvider } from "./sportsDataProvider";
import { MockSportsDataProvider } from "./providers/mockProvider";
import { HttpSportsDataProvider } from "./providers/httpProvider";

// Set SPORTS_DATA_PROVIDER=http in .env once real API credentials are
// configured. Defaults to the mock provider so the whole pipeline can be
// built and tested without a paid subscription.
export function getSportsDataProvider(): SportsDataProvider {
  const providerName = process.env.SPORTS_DATA_PROVIDER || "mock";

  if (providerName === "http") {
    return new HttpSportsDataProvider();
  }

  return new MockSportsDataProvider();
}
