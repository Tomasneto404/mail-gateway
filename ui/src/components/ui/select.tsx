// Authored by Tomás Neto (TN 2026)
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Select as SelectPrimitive } from "radix-ui"

/**
 * Themed replacement for <select>: the native list is painted by the OS (white in dark mode on
 * Linux/Firefox). Same surface, hairline and shadow as the dropdown menus.
 */
function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = "sm",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "group/select bg-card border-input flex w-fit min-w-0 items-center justify-between gap-2 rounded-md border pr-2 pl-2.5 text-sm whitespace-nowrap shadow-[var(--shadow-sm)] outline-none transition-[color,border-color,box-shadow]",
        "hover:border-foreground/20 focus-visible:ring-ring/50 focus-visible:ring-[3px] data-[state=open]:border-foreground/20",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        "data-[size=default]:h-9 data-[size=sm]:h-8 data-[placeholder]:text-muted-foreground",
        "*:data-[slot=select-value]:truncate",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="text-muted-foreground size-4 shrink-0 transition-transform duration-150 group-data-[state=open]/select:rotate-180" strokeWidth={1.5} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "bg-popover text-popover-foreground relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-hidden rounded-[10px] border shadow-[var(--shadow-pop)]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]",
          "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
          position === "popper" && "w-(--radix-select-trigger-width) min-w-max",
          className
        )}
        position={position}
        align={align}
        sideOffset={sideOffset}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="max-h-80 p-1 scroll-my-1">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label data-slot="select-label" className={cn("text-muted-foreground px-2 pt-1.5 pb-1 text-xs", className)} {...props} />
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "text-secondary-foreground relative flex h-8 w-full cursor-default items-center gap-2 rounded-md pr-8 pl-2 text-sm outline-hidden select-none",
        "focus:bg-(--menu-hover) focus:text-foreground data-[state=checked]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span data-slot="select-item-indicator" className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" strokeWidth={1.75} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator data-slot="select-separator" className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)} {...props} />
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton data-slot="select-scroll-up-button" className={cn("text-muted-foreground flex cursor-default items-center justify-center py-1", className)} {...props}>
      <ChevronUpIcon className="size-4" strokeWidth={1.5} />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton data-slot="select-scroll-down-button" className={cn("text-muted-foreground flex cursor-default items-center justify-center py-1", className)} {...props}>
      <ChevronDownIcon className="size-4" strokeWidth={1.5} />
    </SelectPrimitive.ScrollDownButton>
  )
}

/** Value used for the "All …" choice: Radix reserves the empty string for "no selection". */
const ANY = "__any"

/**
 * A filter dropdown: one "All …" choice plus options. `value` undefined = all.
 */
function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  className,
  ...rest
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  allLabel: string
  options: Array<{ value: string; label?: React.ReactNode }>
  className?: string
  "aria-label": string
}) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
      <SelectTrigger aria-label={rest["aria-label"]} className={cn(value === undefined && "text-secondary-foreground", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{allLabel}</SelectItem>
        {options.length > 0 && <SelectSeparator />}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label ?? o.value}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export {
  FilterSelect,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
