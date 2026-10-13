import { useSearchParams } from "react-router";
import { AppPage } from "@/components/layouts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuditTab } from "./AuditTab";
import { BackupsTab } from "./BackupsTab";
import { EmailTab } from "./EmailTab";
import { StatsTab } from "./StatsTab";
import { UsersTab } from "./UsersTab";

const TABS = ["users", "email", "audit", "stats", "backups"] as const;
type TabName = (typeof TABS)[number];

export function AdminPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: TabName = TABS.includes(requested as TabName) ? (requested as TabName) : "users";
  return (
    <AppPage title="Administration" wide>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })}>
        <TabsList aria-label="Administration sections">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
          <TabsTrigger value="stats">Instance</TabsTrigger>
          <TabsTrigger value="backups">Backups</TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="email">
          <EmailTab />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab />
        </TabsContent>
        <TabsContent value="stats">
          <StatsTab />
        </TabsContent>
        <TabsContent value="backups">
          <BackupsTab />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
