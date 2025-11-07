// Import utils
import testContext from '@utils/testContext';

// Import commonTests
import {requestAccessToken} from '@commonTests/BO/advancedParameters/authServer';

import {
  type APIRequestContext,
  boCategoriesCreatePage,
  boCategoriesPage,
  boDashboardPage,
  boLoginPage,
  type BrowserContext,
  FakerCategory,
  type Page,
  utilsPlaywright,
} from '@prestashop-core/ui-testing';

import {expect} from 'chai';

const baseContext: string = 'functional_API_endpoints_category_deleteCategoryId';

// @todo : https://github.com/PrestaShop/PrestaShop/issues/39814
describe.skip('API : DELETE /admin-api/category/{categoryId}', async () => {
  let apiContext: APIRequestContext;
  let browserContext: BrowserContext;
  let page: Page;
  let idCategory: number;
  let accessToken: string;
  let numberOfCategories: number = 0;

  const clientScope: string = 'category_write';
  const createCategory: FakerCategory = new FakerCategory({
    displayed: true,
  });

  before(async function () {
    browserContext = await utilsPlaywright.createBrowserContext(this.browser);
    page = await utilsPlaywright.newTab(browserContext);

    apiContext = await utilsPlaywright.createAPIContext(global.API.URL);
  });

  after(async () => {
    await utilsPlaywright.closeBrowserContext(browserContext);
  });

  describe('API : Fetch the access token', async () => {
    it(`should request the endpoint /access_token with scope ${clientScope}`, async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'requestOauth2Token', baseContext);
      accessToken = await requestAccessToken(clientScope);
    });
  });

  describe('BackOffice : Create a category', async () => {
    it('should login in BO', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'loginBO', baseContext);

      await boLoginPage.goTo(page, global.BO.URL);
      await boLoginPage.successLogin(page, global.BO.EMAIL, global.BO.PASSWD);

      const pageTitle = await boDashboardPage.getPageTitle(page);
      expect(pageTitle).to.contains(boDashboardPage.pageTitle);
    });

    it('should go to \'Catalog > Categories\' page', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'goToCategoriesPage', baseContext);

      await boDashboardPage.goToSubMenu(
        page,
        boDashboardPage.catalogParentLink,
        boDashboardPage.categoriesLink,
      );
      await boCategoriesPage.closeSfToolBar(page);

      const pageTitle = await boCategoriesPage.getPageTitle(page);
      expect(pageTitle).to.contains(boCategoriesPage.pageTitle);
    });

    it('should reset all filters and get number of categories in BO', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'resetFirst', baseContext);

      numberOfCategories = await boCategoriesPage.resetAndGetNumberOfLines(page);
      expect(numberOfCategories).to.be.above(0);
    });

    it('should go to add new category page', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'goToNewCategoryPage', baseContext);

      await boCategoriesPage.goToAddNewCategoryPage(page);

      const pageTitle = await boCategoriesCreatePage.getPageTitle(page);
      expect(pageTitle).to.contains(boCategoriesCreatePage.pageTitleCreate);
    });

    it('should create category and check the categories number', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'createCategory', baseContext);

      const textResult = await boCategoriesCreatePage.createEditCategory(page, createCategory);
      expect(textResult).to.equal(boCategoriesPage.successfulCreationMessage);

      const numberOfCategoriesAfterCreation = await boCategoriesPage.getNumberOfElementInGrid(page);
      expect(numberOfCategoriesAfterCreation).to.be.equal(numberOfCategories + 1);
    });

    it('should search for the new category and check result', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'searchCreatedCategory', baseContext);

      await boCategoriesPage.resetFilter(page);
      await boCategoriesPage.filterCategories(
        page,
        'input',
        'name',
        createCategory.name,
      );

      const numRows = await boCategoriesPage.getNumberOfElementInGrid(page);
      expect(numRows).to.equal(1);

      idCategory = parseInt(await boCategoriesPage.getTextColumnFromTableCategories(page, 1, 'id_category'), 10);
      expect(idCategory).to.greaterThan(0);
    });
  });

  describe('API : Delete the Category', async () => {
    it('should request the endpoint /category/{categoryId}', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'requestEndpoint', baseContext);

      const apiResponse = await apiContext.delete(`category/${idCategory}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      expect(apiResponse.status()).to.eq(204);
    });
  });

  describe('BackOffice : Check the Category is deleted', async () => {
    it('should filter list of categories', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'filterAfterDeletion', baseContext);

      await boCategoriesPage.resetFilter(page);
      await boCategoriesPage.filterCategories(page, 'id_category', idCategory.toString());

      const numberOfAttributesAfterDelete = await boCategoriesPage.getNumberOfElementInGrid(page);
      expect(numberOfAttributesAfterDelete).to.equal(0);
    });

    it('should reset all filters and get number of categories in BO', async function () {
      await testContext.addContextItem(this, 'testIdentifier', 'resetFilterAfterDeletion', baseContext);

      const numberOfCategories = await boCategoriesPage.resetAndGetNumberOfLines(page);
      expect(numberOfCategories).to.be.above(0);
    });
  });
});
