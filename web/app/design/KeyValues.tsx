import type { HTMLAttributes, ReactNode } from "react";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { contentStyles } from "./content.stylex";

/** 용어·값의 의미와 배치는 Astryx가 소유한다. 값은 링크·코드도 받는다. */
export function KeyValues({ items, supporting = false, ...props }: Omit<HTMLAttributes<HTMLElement>, "children"> & {
    items: readonly (readonly [string, ReactNode])[];
    supporting?: boolean;
}) {
    return <MetadataList {...props}>
        {items.map(([label, value], index) => <MetadataListItem key={index} label={label}>
            <Text type={supporting ? "supporting" : "body"} xstyle={contentStyles.plainText}>{value}</Text>
        </MetadataListItem>)}
    </MetadataList>;
}
