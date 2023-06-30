<?xml version="1.0" encoding="UTF-8"?>
<!--
   Purpose:
     Prints every ID of the document structure

   Parameters:
     * sep (text): the separator
     * include-sections (bool): include section elements? 0=no (default), 1=yes

   Input:
     A DocBook 5 document

   Output:
     By default, every ID is on a separate line

   Author:    Thomas Schraitle <toms@opensuse.org>
   Copyright (C) 2023 SUSE Software Solutions Germany GmbH

-->

<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
  xmlns:d="http://docbook.org/ns/docbook">

  <xsl:output method="text" encoding="UTF-8"/>

  <xsl:param name="include-sections" select="0"/>
  <xsl:param name="sep"><xsl:text>
</xsl:text></xsl:param>

  <xsl:template match="text()"/>

  <xsl:template match="d:appendix|d:article|d:book|d:chapter|d:glossary|d:set|d:topic|d:part|d:preface">
    <xsl:call-template name="output-id"/>
    <xsl:apply-templates/>
  </xsl:template>

  <xsl:template match="d:section|d:sect1|d:sect2|d:sect3|d:sect4|d:sect5">
    <xsl:if test="$include-sections != 0">
      <xsl:call-template name="output-id"/>
    </xsl:if>
    <xsl:apply-templates/>
  </xsl:template>

  <xsl:template name="output-id">
    <xsl:param name="node" select="."/>
    <xsl:param name="id" select="$node/@xml:id"/>

    <xsl:if test="$id">
      <xsl:value-of select="concat($id, $sep)"/>
    </xsl:if>
  </xsl:template>

</xsl:stylesheet>