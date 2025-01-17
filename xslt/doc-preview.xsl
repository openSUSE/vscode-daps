<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:d="http://docbook.org/ns/docbook"
    xmlns:dm="urn:x-suse:ns:docmanager"
    xmlns:exsl="http://exslt.org/common"
    xmlns:date="http://exslt.org/dates-and-times"
    xmlns="http://www.w3.org/1999/xhtml"
    exclude-result-prefixes="exsl date d dm"
    xmlns:xi="http://www.w3.org/2001/XInclude">

  <xsl:import href="http://docbook.sourceforge.net/release/xsl-ns/current/xhtml5/docbook.xsl"/>

  <!-- add here your parameters, for example: -->
  <xsl:param name="docbook.css.source"></xsl:param>
  <xsl:param name="chapter.autolabel" select="1"></xsl:param>
  <xsl:param name="section.autolabel" select="1"></xsl:param>
  <xsl:param name="callout.graphics" select="0"></xsl:param>
  <xsl:param name="abstract.notitle.enabled" select="1"></xsl:param>

  <!-- <xsl:template match="xi:include"/> -->
  <xsl:template match="xi:include">
  <div class="xinclude">
    INCLUDES <span><xsl:value-of select="@href"/></span>
  </div>
</xsl:template>

</xsl:stylesheet>