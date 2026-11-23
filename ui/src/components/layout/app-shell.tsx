// Authored by Tomás Neto (TN 2026)
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Bell,
  BookOpen,
  CheckCheck,
  FileText,
  Fingerprint,
  KeyRound,
  LayoutDashboard,
  Lock,
  LogOut,
  Mail,
  Menu,
  Monitor,
  Moon,
  PauseCircle,
  PlayCircle,
  Route as RouteIcon,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sun,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, call, setCsrfToken } from '@/api/client';
import { usePauseGateway, useResumeGateway, useSystemState } from '@/api/queries';
import { AccountSecurityDialog } from '@/components/account/account-security-dialog';
import { TwoFactorDialog } from '@/components/account/two-factor-dialog';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { TourPrompt, TourProvider, useTour } from '@/components/tour/tour';
import { Dot } from '@/components/common/badges';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useMe } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/** Navigation, each entry visible with ANY of its permissions (the server enforces them too). */
export const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, key: 'g d', perms: ['dashboard:read'] },
  { to: '/keys', label: 'API keys', icon: KeyRound, key: 'g k', perms: ['keys:read'] },
  { to: '/messages', label: 'Messages', icon: Mail, key: 'g m', perms: ['messages:read'] },
  { to: '/approvals', label: 'Approvals', icon: CheckCheck, key: 'g a', perms: ['messages:read'] },
  { to: '/users', label: 'Admin users', icon: Users, key: 'g u', perms: ['users:read'] },
  { to: '/roles', label: 'Roles', icon: Shield, key: 'g r', perms: ['users:read', 'roles:manage'] },
  { to: '/templates', label: 'Templates', icon: FileText, key: 'g t', perms: ['templates:read'] },
  { to: '/alerts', label: 'Alerts', icon: Bell, key: 'g n', perms: ['alerts:read'] },
  { to: '/activity', label: 'Activity log', icon: Activity, key: 'g l', perms: ['audit:read'] },
  { to: '/settings', label: 'Settings', icon: Settings, key: 'g s', perms: ['settings:read'] },
] as const;

/**
 * The signal light: the gateway's state, always in view at the top of the sidebar.
 * Running = steady green, paused = amber, paused by a tripped breaker = red.
 */
export function GatewayPill() {
  const { can } = useMe();
  const { data } = useSystemState(can('dashboard:read'));
  if (!data) return null;
  const open = data.breakers.some((b) => b.state === 'open');
  const tone = !data.gateway.paused ? 'green' : open ? 'red' : 'amber';
  return (
    <Link
      to="/"
      data-testid="gateway-pill"
      data-tour="gateway-signal"
      className="text-secondary-foreground hover:text-foreground inline-flex items-center gap-2 text-xs"
      title={data.gateway.paused ? (data.gateway.reason ?? 'Paused') : 'Accepting and delivering mail'}
    >
      <Dot tone={tone} className={tone === 'green' ? 'shadow-[0_0_0_3px] shadow-positive/15' : tone === 'red' ? 'shadow-[0_0_0_3px] shadow-destructive/15' : 'shadow-[0_0_0_3px] shadow-warning/15'} />
      {data.gateway.paused ? (open ? 'Breaker open' : 'Paused') : 'Running'}
    </Link>
  );
}

export function AppShell() {
  return (
    <TourProvider>
      <Shell />
    </TourProvider>
  );
}

function Shell() {
  const tour = useTour();
  const { user, can, canAny } = useMe();
  const nav = NAV.filter((n) => canAny(...n.perms));
  const { data: sys } = useSystemState(can('dashboard:read'));
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [cmd, setCmd] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [security, setSecurity] = useState<'password' | 'passkeys' | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const pause = usePauseGateway();
  const resume = useResumeGateway();

  // ⌘K / Ctrl+K palette and "g x" chords
  useEffect(() => {
    let g = false;
    let t: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        g = true;
        clearTimeout(t);
        t = setTimeout(() => (g = false), 800);
        return;
      }
      if (g) {
        const n = NAV.find((x) => x.key === `g ${e.key}`);
        if (n && canAny(...n.perms)) navigate({ to: n.to });
        g = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, canAny]);

  const logout = async () => {
    const r = await call(api.POST('/admin/auth/logout')).catch(() => ({ redirect: null }));
    setCsrfToken(null);
    qc.clear();
    if (r.redirect) window.location.href = r.redirect;
    else navigate({ to: '/login', search: { error: undefined } });
  };

  const isActive = (to: string) => (to === '/' ? path === '/ui/' || path === '/ui' || path === '/' : path.includes(to));

  /** Sidebar body, shared by the desktop sidebar and the mobile menu sheet. */
  const sidebar = (mobile: boolean) => (
    <>
        <div className="flex h-14 items-center justify-between gap-2 px-5">
          <span className="text-[15px] font-medium">mail-gateway</span>
          {!mobile && <GatewayPill />}
        </div>
        <button
          data-tour="search"
          onClick={() => {
            setMobileNav(false);
            setCmd(true);
          }}
          className="text-muted-foreground hover:text-foreground bg-card mx-3 mb-4 flex h-8 items-center gap-2 rounded-md border px-2 text-sm shadow-[var(--shadow-sm)] transition-colors"
        >
          <Search className="size-4" strokeWidth={1.5} /> Search
          <kbd className="text-muted-foreground ml-auto rounded-sm border px-1 font-mono text-xs leading-4">⌘K</kbd>
        </button>
        <nav className="grid gap-0.5 px-3">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setMobileNav(false)}
              data-tour={`nav-${n.to.slice(1) || 'dashboard'}`}
              className={cn(
                'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors',
                isActive(n.to)
                  ? 'bg-sidebar-active text-foreground shadow-[var(--shadow-sm)] ring-border ring-1'
                  : 'text-secondary-foreground hover:bg-sidebar-active/60 hover:text-foreground',
              )}
            >
              <n.icon className={cn('size-4', isActive(n.to) ? 'text-foreground' : 'text-muted-foreground')} strokeWidth={1.5} />
              {n.label}
              {n.to === '/approvals' && !!sys?.pendingApprovals && (
                <span className="text-brand ml-auto font-mono text-xs tabular" aria-label={`${sys.pendingApprovals} pending`}>
                  {sys.pendingApprovals}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="mt-auto" />
        <TourPrompt />
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="text-secondary-foreground hover:bg-sidebar-active/60 hover:text-foreground mx-3 mb-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors"
        >
          <BookOpen className="text-muted-foreground size-4" strokeWidth={1.5} /> API docs
        </a>
        <div className="border-t p-3">
          <DropdownMenu>
            <DropdownMenuTrigger data-tour="user-menu" className="hover:bg-sidebar-active/60 flex w-full items-center gap-2.5 rounded-md p-2 text-left text-sm transition-colors">
              <span className="bg-card text-secondary-foreground grid size-7 place-items-center rounded-full border text-xs font-medium uppercase">{user?.email[0]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" data-testid="current-user">{user?.email}</span>
                <span className="text-muted-foreground block truncate text-xs" data-testid="current-roles">
                  {user?.roles.map((r) => r.name).join(', ') || 'no roles'}
                </span>
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setTheme('light')}>
                <Sun className="size-4" /> Light {theme === 'light' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('dark')}>
                <Moon className="size-4" /> Dark {theme === 'dark' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('system')}>
                <Monitor className="size-4" /> System {theme === 'system' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setTwoFactor(true)}>
                <ShieldCheck className="size-4" /> Two-factor authentication
                {user?.authSource === 'local' && !user.totpEnrolled && <span className="text-muted-foreground ml-auto text-xs">off</span>}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSecurity('password')}>
                <Lock className="size-4" /> Password and sessions
              </DropdownMenuItem>
              {user?.authSource === 'local' && (
                <DropdownMenuItem onClick={() => setSecurity('passkeys')}>
                  <Fingerprint className="size-4" /> Passkeys
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={tour.start}>
                <RouteIcon className="size-4" /> Guided tour
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout}>
                <LogOut className="size-4" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
    </>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="bg-sidebar hidden w-60 shrink-0 flex-col border-r md:flex">{sidebar(false)}</aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 md:hidden">
          <Button size="icon" variant="ghost" aria-label="Open menu" onClick={() => setMobileNav(true)}>
            <Menu />
          </Button>
          <span className="font-medium">mail-gateway</span>
          <span className="ml-auto">
            <GatewayPill />
          </span>
        </div>
        <Sheet open={mobileNav} onOpenChange={setMobileNav}>
          <SheetContent side="left" className="bg-sidebar w-72 p-0" bodyClassName="gap-0" aria-describedby={undefined}>
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {sidebar(true)}
          </SheetContent>
        </Sheet>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </main>

      <CommandDialog open={cmd} onOpenChange={setCmd}>
        <CommandInput placeholder="Go to or run" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {nav.map((n) => (
              <CommandItem
                key={n.to}
                onSelect={() => {
                  setCmd(false);
                  navigate({ to: n.to });
                }}
              >
                <n.icon className="size-4" /> {n.label}
                <span className="text-muted-foreground ml-auto font-mono text-xs">{n.key}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {can('gateway:pause') && sys && (
            <CommandGroup heading="Gateway">
              {sys.gateway.paused ? (
                <CommandItem
                  onSelect={() => {
                    setCmd(false);
                    resume.mutate();
                  }}
                >
                  <PlayCircle className="size-4" /> Resume gateway
                </CommandItem>
              ) : (
                <CommandItem
                  onSelect={() => {
                    setCmd(false);
                    setConfirmPause(true);
                  }}
                >
                  <PauseCircle className="size-4" /> Pause gateway
                </CommandItem>
              )}
            </CommandGroup>
          )}
          <CommandGroup heading="Help">
            <CommandItem
              onSelect={() => {
                setCmd(false);
                tour.start();
              }}
            >
              <RouteIcon className="size-4" /> Start guided tour
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <Moon className="size-4" /> Toggle dark mode
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <TwoFactorDialog open={twoFactor} onOpenChange={setTwoFactor} />
      <AccountSecurityDialog tab={security} onClose={() => setSecurity(null)} />
      <PauseDialog open={confirmPause} onOpenChange={setConfirmPause} onConfirm={(r) => pause.mutateAsync(r || 'manual (admin UI)')} />
    </div>
  );
}

export function PauseDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (reason: string) => Promise<unknown> }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pause the gateway?"
      description="New sends are rejected with GATEWAY_PAUSED and queued deliveries wait until you resume"
      confirmLabel="Pause gateway"
      destructive
      reasonLabel="Reason (shown in the activity log)"
      onConfirm={async (r) => {
        await onConfirm(r);
      }}
    />
  );
}
