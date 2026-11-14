import { Box, Text } from "ink";
import React from "react";

export interface PanelProps {
  title: string;
  index: number;
  focused: boolean;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  children?: React.ReactNode;
  right?: string;
}

/** Bordered panel; the focused one gets a highlighted border and bold title. */
export function Panel({ title, index, focused, width, height, flexGrow, children, right }: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      width={width}
      height={height}
      flexGrow={flexGrow}
      // Equal shares for side-by-side panels regardless of content length
      flexBasis={flexGrow ? 0 : undefined}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text bold={focused} color={focused ? "cyan" : undefined} wrap="truncate">
          {index} {title}
        </Text>
        {right ? (
          <Text dimColor wrap="truncate">
            {right}
          </Text>
        ) : null}
      </Box>
      {/* Rows never shrink: content taller than the panel is clipped, not squashed into overlapping lines. */}
      <Box flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}

/** "label  value" row with a fixed-width dim label. */
export function Row({ label, children, width = 13 }: { label: string; children: React.ReactNode; width?: number }) {
  return (
    <Box>
      <Box width={width} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text wrap="truncate">{children}</Text>
    </Box>
  );
}
