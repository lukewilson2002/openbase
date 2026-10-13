import { useSearchParams } from "react-router";
import { AppPage } from "@/components/layouts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageSpinner } from "@/components/ui/spinner";
import { useMe } from "@/auth/useAuth";
import { ProfileSection } from "./ProfileSection";
import { SecuritySection } from "./SecuritySection";
import { SessionsSection } from "./SessionsSection";
import { TokensSection } from "./TokensSection";

const TABS = ["profile", "security", "sessions", "tokens"] as const;
type TabName = (typeof TABS)[number];

export function AccountPage() {
  const { data: user } = useMe();
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabName = TABS.includes(requested as TabName) ? (requested as TabName) : "profile";

  if (!user) return <PageSpinner />;
  return (
    <AppPage title="Account settings">
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList aria-label="Account sections">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="tokens">API tokens</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <ProfileSection user={user} />
        </TabsContent>
        <TabsContent value="security" className="flex flex-col gap-6">
          <SecuritySection user={user} />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsSection />
        </TabsContent>
        <TabsContent value="tokens">
          <TokensSection />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
