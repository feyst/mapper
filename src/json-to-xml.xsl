<!--
    Turns a JSON source into the XML that customer templates are applied to. json-to-xml() puts every element in the
    http://www.w3.org/2005/xpath-functions namespace, but templates written for a JSON source match unprefixed /map and
    string[@key], so the elements are moved into no namespace.
-->
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:xs="http://www.w3.org/2001/XMLSchema" exclude-result-prefixes="xs">
    <xsl:param name="json" as="xs:string" required="yes"/>
    <xsl:template name="xsl:initial-template">
        <xsl:apply-templates select="json-to-xml($json)" mode="removeNamespace"/>
    </xsl:template>
    <xsl:template match="*" mode="removeNamespace">
        <xsl:element name="{local-name()}">
            <xsl:apply-templates select="@* | node()" mode="removeNamespace"/>
        </xsl:element>
    </xsl:template>
    <xsl:template match="@*" mode="removeNamespace">
        <xsl:attribute name="{local-name()}"><xsl:value-of select="."/></xsl:attribute>
    </xsl:template>
</xsl:stylesheet>
